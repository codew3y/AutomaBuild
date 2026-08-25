/**
 * Steps 3 and 4: resolve every record, validate every address.
 *
 * "Every" is load-bearing. A hostname with one public A record and one private
 * A record is not a misconfiguration, it is an attack that relies on you
 * checking the first answer and connecting to the second.
 */

import { Resolver } from 'node:dns/promises'
import { SsrfBlockedError } from './errors.ts'
import { type Blocklist, validateAddress } from './blocklist.ts'
import { type IpFamily, ipToString, parseIp } from './ip.ts'

export interface AddressResolver {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
}

export interface ResolvedAddress {
  readonly text: string
  readonly bytes: Uint8Array
  readonly family: IpFamily
}

/**
 * The default resolver uses `dns.resolve*` (c-ares) rather than `dns.lookup`
 * (getaddrinfo). That is deliberate: `resolve*` returns the full record set,
 * which is what we need to validate, and it ignores `/etc/hosts`, so a local
 * hosts entry cannot quietly redirect a name we have approved.
 */
export function createDefaultResolver(servers?: readonly string[]): AddressResolver {
  const resolver = new Resolver()
  if (servers !== undefined && servers.length > 0) resolver.setServers([...servers])
  return {
    resolve4: (hostname) => resolver.resolve4(hostname),
    resolve6: (hostname) => resolver.resolve6(hostname),
  }
}

/** DNS errors that mean "this family has no records", not "resolution broke". */
const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EBADRESP'])

async function resolveFamily(
  lookup: () => Promise<string[]>,
): Promise<{ addresses: string[]; error: NodeJS.ErrnoException | null }> {
  try {
    return { addresses: await lookup(), error: null }
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    if (error.code !== undefined && EMPTY_CODES.has(error.code)) {
      return { addresses: [], error: null }
    }
    return { addresses: [], error }
  }
}

/**
 * Resolve `hostname` and return every address, having proved that none of them
 * is blocked. Throws `SsrfBlockedError` on the first bad address.
 */
export async function resolveAndValidate(
  hostname: string,
  list: Blocklist,
  resolver: AddressResolver,
  context: { url: string; hop: number },
): Promise<ResolvedAddress[]> {
  const [v4, v6] = await Promise.all([
    resolveFamily(() => resolver.resolve4(hostname)),
    resolveFamily(() => resolver.resolve6(hostname)),
  ])

  if (v4.error !== null && v6.error !== null) {
    throw new SsrfBlockedError({
      reason: 'dns-resolution-failed',
      message: `Could not resolve ${hostname}: ${v4.error.code ?? v4.error.message}`,
      url: context.url,
      hostname,
      hop: context.hop,
    })
  }

  const seen = new Set<string>()
  const resolved: ResolvedAddress[] = []
  for (const text of [...v4.addresses, ...v6.addresses]) {
    if (seen.has(text)) continue
    seen.add(text)
    const parsed = parseIp(text)
    if (parsed === null) {
      // A resolver that answers with something unparseable is not one we trust.
      throw new SsrfBlockedError({
        reason: 'dns-resolution-failed',
        message: `Resolver returned an address that could not be parsed: ${JSON.stringify(text)}`,
        url: context.url,
        hostname,
        hop: context.hop,
      })
    }
    resolved.push({
      text: ipToString(parsed.bytes),
      bytes: parsed.bytes,
      family: parsed.family,
    })
  }

  if (resolved.length === 0) {
    throw new SsrfBlockedError({
      reason: 'no-addresses',
      message: `${hostname} has no A or AAAA records`,
      url: context.url,
      hostname,
      hop: context.hop,
    })
  }

  for (const address of resolved) {
    const verdict = validateAddress(list, address.bytes, address.text)
    if (!verdict.allowed) {
      throw new SsrfBlockedError({
        reason: verdict.reason,
        message: `${hostname} resolves to ${address.text}, which is in blocked range ${verdict.matchedRange}`,
        url: context.url,
        hostname,
        resolvedIp: address.text,
        matchedRange: verdict.matchedRange,
        hop: context.hop,
      })
    }
  }

  return resolved
}
