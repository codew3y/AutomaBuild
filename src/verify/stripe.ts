/**
 * Stripe.
 *
 *   Stripe-Signature: t=1614556800,v1=abc…,v1=def…
 *   signed payload:   `${t}.${rawBody}`
 *
 * Two traps specific to this scheme:
 *
 * **Downgrade.** The header is a list of comma-separated `scheme=value`
 * pairs, and nothing stops a sender — or an attacker — adding a pair for some
 * other scheme. An implementation that takes "the first signature" or "any
 * signature that matches" can be handed `v0=<forged>` and will happily verify
 * it against an algorithm nobody meant to accept. Only `v1` is looked at here;
 * everything else is ignored, and a header with no `v1` at all is malformed
 * rather than unverified.
 *
 * **Rotation.** During a secret roll — up to 24 hours — Stripe sends *several*
 * `v1` signatures in one header, one per active secret. Verifying only the
 * first drops legitimate traffic for a day.
 */

import {
  DEFAULT_TOLERANCE_SECONDS,
  type VerificationResult,
  type VerifyInput,
  checkTolerance,
  header,
  hmacHex,
  matchAnySignature,
  preflight,
  toBuffer,
} from './common.ts'

export interface StripeSignatureHeader {
  readonly timestamp: number
  readonly v1: readonly string[]
  /** Schemes present but deliberately ignored, for observability. */
  readonly ignoredSchemes: readonly string[]
}

export function parseStripeSignature(value: string): StripeSignatureHeader | null {
  let timestamp: number | null = null
  const v1: string[] = []
  const ignored = new Set<string>()

  for (const part of value.split(',')) {
    const separator = part.indexOf('=')
    if (separator === -1) return null
    const key = part.slice(0, separator).trim()
    const item = part.slice(separator + 1).trim()
    if (key === 't') {
      if (!/^[0-9]+$/.test(item)) return null
      timestamp = Number(item)
    } else if (key === 'v1') {
      v1.push(item)
    } else {
      ignored.add(key)
    }
  }

  if (timestamp === null || v1.length === 0) return null
  return { timestamp, v1, ignoredSchemes: [...ignored] }
}

export function verifyStripe(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  const raw = header(input.headers, 'stripe-signature')
  if (raw === undefined) return { ok: false, reason: 'missing_signature' }

  const parsed = parseStripeSignature(raw)
  if (parsed === null) {
    return { ok: false, reason: 'malformed_signature', detail: 'no t= and v1= pair' }
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = input.now ?? new Date()
  const time = checkTolerance(parsed.timestamp, tolerance, now)
  if (!time.ok) {
    return {
      ok: false,
      reason: time.reason!,
      ...(time.skewSeconds === undefined ? {} : { detail: `${Math.round(time.skewSeconds)}s skew` }),
    }
  }

  // The timestamp is inside the signed payload, which is what stops an
  // attacker replaying a captured body with a fresher `t=`: changing it
  // invalidates every signature.
  const signedPayload = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, 'utf8'),
    toBuffer(input.rawBody),
  ])

  const candidates = input.secrets.map((secret) => hmacHex(secret, signedPayload))
  const secretIndex = matchAnySignature(candidates, parsed.v1)
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  return {
    ok: true,
    // Stripe has no per-delivery id header, so the dedup key is the signature
    // itself: unique per (secret, timestamp, body), and constant across a
    // redelivery of the same event.
    dedupKey: parsed.v1[0]!,
    timestamp: time.timestamp!,
    secretIndex,
  }
}
