/**
 * GitHub.
 *
 *   X-Hub-Signature-256: sha256=abc…
 *   signed payload:      raw body, with no timestamp
 *
 * This scheme is the reason the replay store is not optional.
 *
 * Every other scheme here signs a timestamp alongside the body, so a captured
 * request stops being valid once the tolerance window passes. GitHub signs the
 * body and nothing else, which means **a captured delivery is valid forever**.
 * The signature will still verify next year. The only thing standing between
 * an attacker and replaying it is the delivery id, `X-GitHub-Delivery`, and a
 * store that remembers having seen it.
 *
 * So for GitHub the dedup key is mandatory rather than a nicety, and this
 * verifier refuses a delivery that arrives without one instead of accepting it
 * unprotected.
 *
 * The legacy `X-Hub-Signature` (SHA-1) header is ignored entirely, not merely
 * deprioritised: honouring it lets an attacker choose the weaker algorithm.
 */

import {
  type VerificationResult,
  type VerifyInput,
  header,
  hmacHex,
  matchAnySignature,
  preflight,
  toBuffer,
} from './common.ts'

export function verifyGitHub(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  const presented = header(input.headers, 'x-hub-signature-256')
  if (presented === undefined) {
    // If only the SHA-1 header is present, say so precisely — "missing
    // signature" would send someone hunting a proxy that strips headers.
    const legacy = header(input.headers, 'x-hub-signature')
    if (legacy !== undefined) {
      return {
        ok: false,
        reason: 'unsupported_algorithm',
        detail: 'only X-Hub-Signature (SHA-1) was sent; SHA-256 is required',
      }
    }
    return { ok: false, reason: 'missing_signature' }
  }

  if (!presented.startsWith('sha256=')) {
    return {
      ok: false,
      reason: 'unsupported_algorithm',
      detail: `expected a sha256= prefix, got ${presented.slice(0, 8)}`,
    }
  }
  const signature = presented.slice('sha256='.length)

  // Required, not optional. Without it there is no replay protection at all,
  // and accepting the delivery would be pretending otherwise.
  const deliveryId = header(input.headers, 'x-github-delivery')
  if (deliveryId === undefined || deliveryId.length === 0) {
    return {
      ok: false,
      reason: 'missing_timestamp',
      detail:
        'X-GitHub-Delivery is absent. GitHub signatures carry no timestamp, so without a delivery id a captured request is replayable indefinitely',
    }
  }

  const body = toBuffer(input.rawBody)
  const candidates = input.secrets.map((secret) => hmacHex(secret, body))
  const secretIndex = matchAnySignature(candidates, [signature])
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  // The dedup key is the signature we computed, not the delivery id.
  //
  // This is the whole of GitHub's replay protection, so it matters that the
  // key be something the sender cannot choose. `X-GitHub-Delivery` is not:
  // GitHub signs the body and nothing else, so the header sits outside the
  // signed envelope and any value at all can be put in it. Keying on it meant
  // that one captured (body, signature) pair could be replayed forever, a
  // fresh delivery id each time, every replay looking like a first delivery
  // and starting another run. There is no timestamp in this scheme to bound
  // it either.
  //
  // The computed signature is a function of the secret and the body, so it is
  // identical across a genuine redelivery — which is what dedup is for — and
  // cannot be varied by anyone who does not hold the secret. `candidates` is
  // indexed by `secretIndex` rather than using `signature`, so that during a
  // rotation the key is the one belonging to the secret that actually
  // matched.
  //
  // The delivery id is still required above. It is what makes the scheme
  // legible in a log, and its absence is a sign of a sender that is not
  // GitHub.
  //
  // No timestamp is returned, deliberately: the scheme does not carry one, and
  // inventing `new Date()` here would let a caller believe it had freshness
  // information it does not have.
  return { ok: true, dedupKey: candidates[secretIndex]!, secretIndex }
}
