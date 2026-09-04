/**
 * A shared token, for senders that cannot sign.
 *
 *   X-Webhook-Token: <the secret>
 *   or
 *   Authorization: Bearer <the secret>
 *
 * **This is the weakest scheme here, and it is included deliberately.**
 *
 * A large class of business tools — Zoho CRM, most no-code builders, anything
 * whose webhook configuration offers "custom headers" — do not sign anything.
 * They will send a header you choose, with a value you choose, and that is the
 * whole of what they offer. Refusing to support them does not make those
 * integrations secure; it makes them impossible, and the practical answer
 * people reach for is an unauthenticated endpoint, which is worse than this by
 * a wide margin.
 *
 * What it does give: the sender proves it holds a secret, compared in constant
 * time. That is strictly more than Zapier's Catch Hook, which verifies nothing
 * at all and relies on the URL staying unguessed.
 *
 * What it does not give, and what an HMAC scheme does:
 *
 *   - **No integrity.** The body is not covered. Anyone holding the token can
 *     send any payload they like, and a proxy between the sender and here can
 *     alter one in flight.
 *   - **No freshness.** There is no timestamp, so a captured request stays
 *     valid until the token is rotated.
 *   - **No replay protection worth the name.** The dedup key can only be
 *     derived from the body, so a redelivery of the same event is recognised —
 *     but an attacker holding the token varies the body and gets a new key.
 *
 * Every one of those is a reason to prefer a signed scheme where the sender
 * offers one. Use this where it is the only option, over TLS, with a token
 * long enough not to be guessed, and rotate it like a password.
 */

import {
  type VerificationResult,
  type VerifyInput,
  header,
  hmacBase64,
  preflight,
  secureCompare,
  toBuffer,
} from './common.ts'

/** The header a sender should be configured to send. */
const TOKEN_HEADER = 'x-webhook-token'

export function verifyToken(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  // Two places to look, because some senders offer a free-form header and
  // others only an "Authorization" field. Both carry the same value.
  const direct = header(input.headers, TOKEN_HEADER)
  const authorization = header(input.headers, 'authorization')
  const bearer =
    authorization !== undefined && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '')
      : undefined

  const presented = direct !== undefined && direct !== '' ? direct : bearer
  if (presented === undefined || presented === '') {
    return {
      ok: false,
      reason: 'missing_signature',
      detail: `expected an ${TOKEN_HEADER} header, or an Authorization: Bearer value`,
    }
  }

  // Compared against every current secret so this scheme rotates like the
  // others, and in constant time so the comparison leaks nothing about how
  // much of a guess was right.
  let secretIndex = -1
  for (const [index, secret] of input.secrets.entries()) {
    if (secureCompare(secret, presented) && secretIndex === -1) secretIndex = index
  }
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  return {
    ok: true,
    // Derived from the body, which is the only thing that distinguishes one
    // delivery from another here. It de-duplicates a genuine redelivery, which
    // is what dedup is for — it is not a defence, because nothing about the
    // body is authenticated in this scheme. Keyed with the secret only so the
    // value is not something a reader of the database can compute at will.
    dedupKey: hmacBase64(input.secrets[secretIndex]!, toBuffer(input.rawBody)),
    secretIndex,
  }
}
