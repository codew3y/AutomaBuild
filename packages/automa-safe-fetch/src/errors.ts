/**
 * Every reason a request can be refused before or during connection.
 *
 * These are stable identifiers: log them, alert on them, switch on them. A
 * tenant producing `blocked-range` or `metadata-endpoint` is not misconfigured,
 * they are probing you (plan section 7.6, layer 4).
 */
export type BlockReason =
  | 'scheme-not-allowed'
  | 'userinfo-in-url'
  | 'port-not-allowed'
  | 'malformed-url'
  | 'ip-literal-encoded'
  | 'blocked-hostname'
  | 'dns-resolution-failed'
  | 'no-addresses'
  | 'blocked-range'
  | 'ipv4-mapped-ipv6'
  | 'metadata-endpoint'
  | 'unpinned-resolution'

/** Base class for everything this library throws. */
export class SafeFetchError extends Error {
  override readonly name: string = 'SafeFetchError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/**
 * The request was refused because it resolved somewhere it must not reach.
 *
 * `resolvedIp` is present whenever the decision was made about a specific
 * address rather than about the URL's shape. Log it — it is the single most
 * useful field for detection.
 */
export class SsrfBlockedError extends SafeFetchError {
  override readonly name = 'SsrfBlockedError'
  readonly reason: BlockReason
  readonly url: string
  readonly hostname: string
  readonly resolvedIp?: string
  /** The matched deny-list CIDR, when the block came from a range match. */
  readonly matchedRange?: string
  /** Which redirect hop refused it. 0 is the URL the caller supplied. */
  readonly hop: number

  constructor(init: {
    reason: BlockReason
    message: string
    url: string
    hostname: string
    resolvedIp?: string
    matchedRange?: string
    hop?: number
  }) {
    super(init.message)
    this.reason = init.reason
    this.url = init.url
    this.hostname = init.hostname
    if (init.resolvedIp !== undefined) this.resolvedIp = init.resolvedIp
    if (init.matchedRange !== undefined) this.matchedRange = init.matchedRange
    this.hop = init.hop ?? 0
  }
}

/** The response body exceeded `maxResponseBytes`. The stream was aborted, not buffered. */
export class ResponseTooLargeError extends SafeFetchError {
  override readonly name = 'ResponseTooLargeError'
  readonly limitBytes: number
  readonly url: string
  constructor(limitBytes: number, url: string) {
    super(`Response body exceeded ${limitBytes} bytes and was aborted (${url})`)
    this.limitBytes = limitBytes
    this.url = url
  }
}

/** The redirect chain was longer than `maxRedirects`. */
export class TooManyRedirectsError extends SafeFetchError {
  override readonly name = 'TooManyRedirectsError'
  readonly maxRedirects: number
  readonly url: string
  constructor(maxRedirects: number, url: string) {
    super(
      maxRedirects === 0
        ? `Server returned a redirect but redirects are disabled (${url})`
        : `Exceeded ${maxRedirects} redirect hops (${url})`,
    )
    this.maxRedirects = maxRedirects
    this.url = url
  }
}

/** The request did not complete within `timeoutMs`. */
export class SafeFetchTimeoutError extends SafeFetchError {
  override readonly name = 'SafeFetchTimeoutError'
  readonly timeoutMs: number
  readonly url: string
  constructor(timeoutMs: number, url: string) {
    super(`Request timed out after ${timeoutMs} ms (${url})`)
    this.timeoutMs = timeoutMs
    this.url = url
  }
}
