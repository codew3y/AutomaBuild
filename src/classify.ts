/**
 * Mapping real failures onto the classification table.
 *
 * The interesting decisions are the ones that are not simple status-code
 * lookups:
 *
 * - A 500 means something different depending on whether we can safely repeat
 *   the call. The table's `conditional` rows carry that.
 * - A socket that died *after* the request was written is not the same as one
 *   that never connected. The first is `unknown_outcome`; the second is an
 *   ordinary transient failure. Most engines record both as ECONNRESET and
 *   retry, which is how a payment gets taken twice.
 */

import type { ErrorClass } from './error-classes.ts'

/** What the executor knows about a failed attempt. */
export interface FailureFacts {
  readonly httpStatus?: number
  /** Node error code: ECONNRESET, ETIMEDOUT, ENOTFOUND, … */
  readonly code?: string
  /** True once the request body has been flushed to the socket. */
  readonly requestSent?: boolean
  /** True when a response — any response — was received. */
  readonly responseReceived?: boolean
  /** Our own deadline fired, as opposed to the peer timing out. */
  readonly deadlineExceeded?: boolean
  /** The payload could not be deserialized, or an evaluator crashed on it. */
  readonly deterministicallyBroken?: boolean
  /** A token refresh has already been attempted for this step. */
  readonly refreshAlreadyAttempted?: boolean
  /** The error escaped our own code rather than the provider's. */
  readonly internal?: boolean
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
])

export function classify(facts: FailureFacts): ErrorClass {
  // Deterministic breakage first: no status code can override the fact that
  // this input will fail identically forever.
  if (facts.deterministicallyBroken === true) return 'poison'
  if (facts.internal === true) return 'internal'

  const status = facts.httpStatus

  if (status !== undefined) {
    if (status === 429) return 'rate_limited'
    if (status === 401 || status === 403) {
      return facts.refreshAlreadyAttempted === true ? 'auth_broken' : 'auth_expired'
    }
    if (status === 408) return 'timeout'
    if (status >= 500) return 'server_error'
    if (status >= 400) return 'client_error'
    // A 2xx/3xx that still reached the classifier is our bug, not theirs.
    return 'internal'
  }

  // No response. The question is whether the request got out of the door.
  if (facts.deadlineExceeded === true) return 'timeout'

  if (facts.code !== undefined && TRANSIENT_CODES.has(facts.code)) {
    // A connection that died after the request was written is the ambiguous
    // case: the far side may have processed it and failed to answer. The
    // conditional rows in the table turn this into unknown_outcome when the
    // call is not safely repeatable.
    if (facts.requestSent === true && facts.responseReceived !== true) return 'timeout'
    return 'transient_network'
  }

  // Nothing recognisable. Treat as ours rather than assuming it is safe.
  return 'internal'
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds.
 *
 * RFC 9110 §10.2.3 allows both a delay in seconds and an HTTP-date. Returns
 * null when absent or unparseable — never a guess, because backing off less
 * than a provider asked is how you get blocked.
 *
 * `now` is passed in rather than read, so the date form is testable.
 */
export function parseRetryAfter(header: string | undefined | null, now: number): number | null {
  if (header === undefined || header === null) return null
  const text = header.trim()
  if (text.length === 0) return null

  if (/^[0-9]+$/.test(text)) {
    return Number(text) * 1000
  }

  const asDate = Date.parse(text)
  if (Number.isNaN(asDate)) return null
  // A date in the past means "you may retry now", not "retry in the past".
  return Math.max(0, asDate - now)
}
