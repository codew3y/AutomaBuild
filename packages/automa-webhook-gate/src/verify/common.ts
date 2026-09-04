/**
 * The parts every scheme shares, and the two mistakes every scheme invites.
 *
 * **Mistake one: comparing signatures with `===`.** String comparison exits at
 * the first differing byte, so how long it takes reveals how much of a guess
 * was correct. Given enough samples that is a signature forgery oracle, byte
 * by byte. GitHub's documentation says it outright: "Never use a plain `==`
 * operator". Every comparison here goes through `timingSafeEqual`.
 *
 * **Mistake two: verifying the parsed body.** A signature covers the exact
 * bytes that arrived. `JSON.parse` then `JSON.stringify` is not those bytes —
 * key order, whitespace and unicode escaping all change — so verification
 * fails for legitimate requests, and the usual fix is to stop verifying. The
 * raw body must reach the verifier untouched.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export type VerificationFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'unsupported_algorithm'
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'timestamp_outside_tolerance'
  | 'signature_mismatch'
  | 'body_too_large'
  | 'missing_secret'

export type VerificationResult =
  | {
      readonly ok: true
      /** Uniquely identifies this delivery, for replay protection. */
      readonly dedupKey: string
      /** When the sender claims it sent this, if the scheme carries it. */
      readonly timestamp?: Date
      /** Which of several accepted secrets matched, for rotation visibility. */
      readonly secretIndex: number
    }
  | { readonly ok: false; readonly reason: VerificationFailure; readonly detail?: string }

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError'
  readonly reason: VerificationFailure
  constructor(reason: VerificationFailure, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`)
    this.reason = reason
  }
}

export interface VerifyInput {
  /**
   * The bytes exactly as they arrived.
   *
   * A string is accepted, but a Buffer is what a framework should hand over —
   * a string implies a decode already happened, and if the charset guess was
   * wrong the bytes are no longer the bytes that were signed.
   */
  readonly rawBody: Buffer | string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  /**
   * Every currently-valid secret. More than one during rotation: a sender may
   * still be signing with the old secret while the new one is being rolled
   * out, and refusing those is a self-inflicted outage.
   */
  readonly secrets: readonly string[]
  /** How far out of date a delivery may be. Default 300 s. */
  readonly toleranceSeconds?: number
  /** Injected so tolerance tests need no real waiting. */
  readonly now?: Date
  /** Reject before hashing anything larger than this. */
  readonly maxBodyBytes?: number
  /**
   * The request method, for schemes that sign it.
   *
   * Most do not: the body carries the intent and the method is always
   * POST. HubSpot signs it, so a signature captured from one endpoint
   * cannot be replayed against another verb.
   */
  readonly method?: string
  /**
   * The absolute URL the request arrived at, for schemes that sign it.
   *
   * Scheme, host, path and query, exactly as the sender addressed it —
   * which behind a proxy is not what the socket saw. Getting this wrong
   * fails every delivery with a signature mismatch, indistinguishable
   * from a wrong secret, so `registerWebhookRoute` builds it from the
   * forwarded headers rather than leaving it to each caller.
   */
  readonly url?: string
}

export const DEFAULT_TOLERANCE_SECONDS = 300
export const DEFAULT_MAX_BODY_BYTES = 1_048_576

export function toBuffer(rawBody: Buffer | string): Buffer {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
}

/** Headers arrive with unpredictable case and may repeat. */
export function header(
  headers: VerifyInput['headers'],
  name: string,
): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue
    if (Array.isArray(value)) {
      // A repeated signature header is either a proxy artefact or someone
      // trying their luck. Neither is worth guessing about.
      return value.length === 1 ? value[0] : undefined
    }
    return value
  }
  return undefined
}

/**
 * Constant-time comparison of two strings.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so length has to
 * be checked first — and that check is not itself a leak, because the length
 * of a signature is fixed by its algorithm and public. What must not leak is
 * *where* two equal-length signatures diverge.
 */
export function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function hmacHex(secret: string, message: Buffer | string): string {
  return createHmac('sha256', secret).update(message).digest('hex')
}

export function hmacBase64(secret: string | Buffer, message: Buffer | string): string {
  return createHmac('sha256', secret).update(message).digest('base64')
}

/**
 * Does any accepted secret produce a signature the sender also sent?
 *
 * Both loops run to completion rather than returning on the first match. An
 * early exit would make "the first secret matched" measurably faster than "the
 * second one did", which over many requests says something about the rotation
 * state — a small leak, but free to avoid.
 */
export function matchAnySignature(
  candidates: readonly string[],
  presented: readonly string[],
): number {
  let matchedIndex = -1
  for (const [index, candidate] of candidates.entries()) {
    for (const signature of presented) {
      if (secureCompare(candidate, signature) && matchedIndex === -1) {
        matchedIndex = index
      }
    }
  }
  return matchedIndex
}

export interface ToleranceCheck {
  readonly ok: boolean
  readonly reason?: Extract<
    VerificationFailure,
    'malformed_timestamp' | 'timestamp_outside_tolerance'
  >
  readonly timestamp?: Date
  readonly skewSeconds?: number
}

/**
 * Is a claimed timestamp close enough to now?
 *
 * Rejects the future as well as the past. A delivery dated an hour ahead is
 * either a badly-skewed sender or an attacker who noticed that only checking
 * the past lets a captured request be replayed indefinitely by post-dating it.
 *
 * A tolerance of zero is refused rather than honoured: it would reject every
 * real delivery, since network transit is never instantaneous. Stripe's own
 * documentation warns against it explicitly.
 */
export function checkTolerance(
  epochSeconds: number,
  toleranceSeconds: number,
  now: Date,
): ToleranceCheck {
  if (!Number.isFinite(epochSeconds)) {
    return { ok: false, reason: 'malformed_timestamp' }
  }
  if (toleranceSeconds <= 0) {
    throw new RangeError(
      'toleranceSeconds must be positive; zero rejects every real delivery because transit is never instantaneous',
    )
  }

  const timestamp = new Date(epochSeconds * 1000)
  const skewSeconds = Math.abs(now.getTime() - timestamp.getTime()) / 1000
  if (skewSeconds > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_outside_tolerance', timestamp, skewSeconds }
  }
  return { ok: true, timestamp, skewSeconds }
}

/** Guard rails applied before any hashing happens. */
export function preflight(input: VerifyInput): VerificationResult | null {
  if (input.secrets.length === 0) {
    return { ok: false, reason: 'missing_secret' }
  }
  const body = toBuffer(input.rawBody)
  const cap = input.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  if (body.byteLength > cap) {
    // Hashing a body before checking its size makes the size limit useless:
    // the memory has already been spent by the time it is enforced.
    return { ok: false, reason: 'body_too_large', detail: `${body.byteLength} > ${cap}` }
  }
  return null
}
