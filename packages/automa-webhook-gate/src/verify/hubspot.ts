/**
 * HubSpot, v3.
 *
 *   X-HubSpot-Signature-v3:     base64sig
 *   X-HubSpot-Request-Timestamp: 1614556800000   (milliseconds)
 *   signed payload:             `${method}${url}${rawBody}${timestamp}`
 *
 * Three things here are unlike every other scheme in this directory, and each
 * one fails in a way that reads as a wrong secret.
 *
 * **The method and the full URL are signed.** Not just the body. That is
 * stronger than the others — a captured signature cannot be replayed against a
 * different path or verb — but it means the verifier has to be told the
 * address the sender used, which behind a proxy is not the address the socket
 * saw. `registerWebhookRoute` builds it from the forwarded headers.
 *
 * **The timestamp is in milliseconds**, where Stripe's and Slack's are in
 * seconds. HubSpot's own guidance is to reject anything older than five
 * minutes, which is the same window the others use, expressed a thousand times
 * larger.
 *
 * **v1 and v2 are not accepted.** HubSpot still sends them for older apps, and
 * neither is an HMAC over a secret in the way v3 is — v1 hashes the secret
 * concatenated with the body, with no timestamp at all. Accepting them because
 * they are present would silently downgrade every delivery, so a request
 * carrying only the older headers is refused rather than checked loosely.
 *
 * HubSpot percent-decodes a few characters in the URI before signing. That is
 * deliberately not replicated: the decoding rule is narrow and easy to get
 * subtly wrong, and a webhook endpoint's path here is a UUID with nothing in
 * it that would ever be encoded. If that changes, this is where it breaks.
 */

import {
  DEFAULT_TOLERANCE_SECONDS,
  type VerificationResult,
  type VerifyInput,
  checkTolerance,
  header,
  hmacBase64,
  matchAnySignature,
  preflight,
  toBuffer,
} from './common.ts'

export function verifyHubSpot(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  const presented = header(input.headers, 'x-hubspot-signature-v3')
  if (presented === undefined || presented.length === 0) {
    // Say so specifically when an older signature is the only one offered. It
    // is the difference between "configure v3" and "your secret is wrong".
    const older =
      header(input.headers, 'x-hubspot-signature') ??
      header(input.headers, 'x-hubspot-signature-version')
    if (older !== undefined) {
      return {
        ok: false,
        reason: 'unsupported_algorithm',
        detail: 'only the v3 signature is accepted; this delivery carried an older one',
      }
    }
    return { ok: false, reason: 'missing_signature' }
  }

  const rawTimestamp = header(input.headers, 'x-hubspot-request-timestamp')
  if (rawTimestamp === undefined) return { ok: false, reason: 'missing_timestamp' }
  if (!/^[0-9]+$/.test(rawTimestamp)) {
    return { ok: false, reason: 'malformed_timestamp', detail: rawTimestamp.slice(0, 32) }
  }

  // Milliseconds here, seconds everywhere else. Converted before the shared
  // tolerance check so one window is enforced across every scheme.
  const seconds = Math.floor(Number(rawTimestamp) / 1000)
  const time = checkTolerance(seconds, input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, input.now ?? new Date())
  if (!time.ok) {
    return {
      ok: false,
      reason: time.reason!,
      ...(time.skewSeconds === undefined ? {} : { detail: `${Math.round(time.skewSeconds)}s skew` }),
    }
  }

  if (input.url === undefined || input.url === '') {
    // Deliberately not a signature mismatch. The delivery may be perfectly
    // genuine; it is the caller that has not supplied what verification needs,
    // and reporting that as a bad signature would send someone to rotate a
    // secret that was never the problem.
    return {
      ok: false,
      reason: 'malformed_signature',
      detail: 'the hubspot scheme signs the request URL, which was not provided',
    }
  }

  const method = (input.method ?? 'POST').toUpperCase()

  const signedPayload = Buffer.concat([
    Buffer.from(`${method}${input.url}`, 'utf8'),
    toBuffer(input.rawBody),
    Buffer.from(rawTimestamp, 'utf8'),
  ])

  const candidates = input.secrets.map((secret) => hmacBase64(secret, signedPayload))
  const secretIndex = matchAnySignature(candidates, [presented])
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  return {
    ok: true,
    // HubSpot sends no per-delivery id, so the key is the signature we
    // computed: unique per (secret, method, url, body, timestamp) and constant
    // across a redelivery of the same event. Never the presented value — that
    // is the sender's to choose, which is how two schemes here were replayable.
    dedupKey: candidates[secretIndex]!,
    timestamp: time.timestamp!,
    secretIndex,
  }
}
