/**
 * Step 1 and 2 of the pipeline: parse the URL, reject the shapes that are
 * never legitimate, and catch IP literals before DNS is involved at all.
 */

import { SsrfBlockedError } from './errors.ts'
import { type Blocklist, validateAddress, validateHostname } from './blocklist.ts'
import { detectEncodedIpLiteral, ipToString, parseIp } from './ip.ts'

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443, 8080, 8443]

export interface UrlPolicy {
  allowedPorts: readonly number[]
  allowedSchemes: readonly string[]
}

export const DEFAULT_URL_POLICY: UrlPolicy = {
  allowedPorts: DEFAULT_ALLOWED_PORTS,
  allowedSchemes: ['http:', 'https:'],
}

export interface ValidatedUrl {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  /** Set when the host was an IP literal, which means no DNS lookup is needed. */
  readonly literalAddress: { bytes: Uint8Array; text: string } | null
}

function defaultPortFor(protocol: string): number {
  return protocol === 'https:' ? 443 : 80
}

/**
 * Validate the shape of a URL and, if its host is an IP literal, the address
 * itself. Throws `SsrfBlockedError`; never returns a partial result.
 *
 * `hop` is threaded through only so the error can say which redirect refused.
 */
export function validateUrl(
  raw: string | URL,
  list: Blocklist,
  policy: UrlPolicy,
  hop = 0,
): ValidatedUrl {
  const text = typeof raw === 'string' ? raw : raw.href

  let url: URL
  try {
    url = new URL(text)
  } catch (cause) {
    throw new SsrfBlockedError({
      reason: 'malformed-url',
      message: `Not a valid absolute URL: ${JSON.stringify(text)}`,
      url: text,
      hostname: '',
      hop,
    })
  }

  if (!policy.allowedSchemes.includes(url.protocol)) {
    throw new SsrfBlockedError({
      reason: 'scheme-not-allowed',
      message: `Scheme ${url.protocol} is not allowed (permitted: ${policy.allowedSchemes.join(', ')})`,
      url: text,
      hostname: url.hostname,
      hop,
    })
  }

  // Credentials in a URL are a redirect-laundering trick far more often than
  // they are a genuine request, and they leak into logs. Refuse them outright.
  if (url.username !== '' || url.password !== '') {
    throw new SsrfBlockedError({
      reason: 'userinfo-in-url',
      message: 'URL contains embedded credentials (user:pass@), which is not allowed',
      url: text,
      hostname: url.hostname,
      hop,
    })
  }

  // Address checks come before the port check on purpose.
  //
  // Both refuse the request, so safety does not depend on the order — but the
  // *reason* does, and the reason is what layer 4 alerts on. "Tried to reach
  // the metadata endpoint" needs to page someone; "port 8022 not permitted"
  // does not. If a port rule ran first it would mask the louder signal.
  // These checks are all local, so nothing is spent to get the better answer.

  // `url.hostname` is already WHATWG-normalised, so the raw host of the input
  // string is the only place the original encoding survives. Look there, so
  // the error can name the trick rather than just reporting 127.0.0.1.
  const rawHost = extractRawHost(text)
  if (rawHost !== null) {
    const encoding = detectEncodedIpLiteral(rawHost)
    if (encoding !== null) {
      const normalised = parseIp(url.hostname)
      throw new SsrfBlockedError({
        reason: 'ip-literal-encoded',
        message: `Host ${JSON.stringify(rawHost)} is an IP address in ${encoding} form (normalises to ${url.hostname}); write addresses in dotted-decimal form`,
        url: text,
        hostname: url.hostname,
        ...(normalised === null ? {} : { resolvedIp: ipToString(normalised.bytes) }),
        hop,
      })
    }
  }

  const hostnameVerdict = validateHostname(list, url.hostname)
  if (hostnameVerdict.blocked) {
    throw new SsrfBlockedError({
      reason: hostnameVerdict.isMetadata ? 'metadata-endpoint' : 'blocked-hostname',
      message: `Hostname ${url.hostname} is blocked by rule ${JSON.stringify(hostnameVerdict.matched)}`,
      url: text,
      hostname: url.hostname,
      hop,
    })
  }

  const literal = parseIp(url.hostname)
  if (literal !== null) {
    const addressText = ipToString(literal.bytes)
    const verdict = validateAddress(list, literal.bytes, addressText)
    if (!verdict.allowed) {
      throw new SsrfBlockedError({
        reason: verdict.reason,
        message: `${addressText} is in blocked range ${verdict.matchedRange}`,
        url: text,
        hostname: url.hostname,
        resolvedIp: addressText,
        matchedRange: verdict.matchedRange,
        hop,
      })
    }
  }

  const port = url.port === '' ? defaultPortFor(url.protocol) : Number(url.port)
  if (!policy.allowedPorts.includes(port)) {
    throw new SsrfBlockedError({
      reason: 'port-not-allowed',
      message: `Port ${port} is not allowed (permitted: ${policy.allowedPorts.join(', ')})`,
      url: text,
      hostname: url.hostname,
      hop,
    })
  }

  if (literal !== null) {
    return {
      url,
      hostname: url.hostname,
      port,
      literalAddress: { bytes: literal.bytes, text: ipToString(literal.bytes) },
    }
  }

  return { url, hostname: url.hostname, port, literalAddress: null }
}

/**
 * Pull the host substring out of the *original* text, before WHATWG
 * normalisation rewrites `0x7f000001` into `127.0.0.1`.
 */
function extractRawHost(text: string): string | null {
  const schemeEnd = text.indexOf('://')
  if (schemeEnd === -1) return null
  let rest = text.slice(schemeEnd + 3)

  const at = rest.lastIndexOf('@', firstIndexOfAny(rest, ['/', '?', '#']))
  if (at !== -1) rest = rest.slice(at + 1)

  const end = firstIndexOfAny(rest, ['/', '?', '#'])
  const authority = end === -1 ? rest : rest.slice(0, end)
  if (authority.startsWith('[')) return null // IPv6 literal, never an encoded v4

  const colon = authority.lastIndexOf(':')
  const host = colon === -1 ? authority : authority.slice(0, colon)
  return host.length === 0 ? null : host
}

function firstIndexOfAny(text: string, needles: readonly string[]): number {
  let best = -1
  for (const needle of needles) {
    const index = text.indexOf(needle)
    if (index !== -1 && (best === -1 || index < best)) best = index
  }
  return best === -1 ? text.length : best
}
