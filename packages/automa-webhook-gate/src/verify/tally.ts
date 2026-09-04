/**
 * Tally.
 *
 *   Tally-Signature: base64(HMAC-SHA256(secret, rawBody))
 *   signed payload:  the raw body, and nothing else
 *
 * The simplest scheme here, and the one with the least in it. No version
 * prefix, no list, no timestamp — one header holding one base64 digest of the
 * body. A secret is optional on Tally's side; an endpoint configured for this
 * scheme requires one, because a verifier that accepts unsigned deliveries is
 * not verifying anything.
 *
 * **No timestamp means no freshness.** Like GitHub, a captured
 * (body, signature) pair stays valid for as long as the secret does, so replay
 * protection rests entirely on the dedup key. The key is the digest computed
 * from the matching secret: constant across a genuine redelivery, and not
 * something a sender can vary without knowing the secret.
 *
 * The body carries an `eventId` that would also serve, and it is inside the
 * signed bytes so it would be safe to trust — but reading it would mean
 * parsing JSON in a verifier whose whole job is to work on bytes, and would
 * fail on a body that is signed correctly and shaped unexpectedly. The digest
 * needs no such assumption.
 *
 * Why this one is worth having: Tally's free tier accepts unlimited form
 * responses, so "a form was submitted" is a trigger that can be exercised as
 * often as a demo needs, which is not true of the alternatives.
 */

import {
  type VerificationResult,
  type VerifyInput,
  header,
  hmacBase64,
  matchAnySignature,
  preflight,
  toBuffer,
} from './common.ts'

export function verifyTally(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  const presented = header(input.headers, 'tally-signature')
  if (presented === undefined || presented.length === 0) {
    return { ok: false, reason: 'missing_signature' }
  }

  const body = toBuffer(input.rawBody)
  const candidates = input.secrets.map((secret) => hmacBase64(secret, body))
  const secretIndex = matchAnySignature(candidates, [presented])
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  // No timestamp is returned, deliberately: the scheme does not carry one, and
  // inventing `new Date()` here would let a caller believe it had freshness
  // information it does not have.
  return { ok: true, dedupKey: candidates[secretIndex]!, secretIndex }
}
