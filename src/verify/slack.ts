/**
 * Slack.
 *
 *   X-Slack-Signature:         v0=abc…
 *   X-Slack-Request-Timestamp: 1614556800
 *   signed payload:            `v0:${timestamp}:${rawBody}`
 *
 * The version prefix is part of the signed string as well as the header, so a
 * `v0=` label cannot be swapped for something else without invalidating the
 * signature. Only `v0` is accepted regardless.
 *
 * Slack's documentation states the five-minute rule explicitly and suggests
 * rejecting stale timestamps outright, which is what `checkTolerance` does in
 * both directions.
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

export function verifySlack(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  const presented = header(input.headers, 'x-slack-signature')
  if (presented === undefined) return { ok: false, reason: 'missing_signature' }
  if (!presented.startsWith('v0=')) {
    return {
      ok: false,
      reason: 'unsupported_algorithm',
      detail: `expected a v0= prefix, got ${presented.slice(0, 4)}`,
    }
  }
  const signature = presented.slice('v0='.length)

  const rawTimestamp = header(input.headers, 'x-slack-request-timestamp')
  if (rawTimestamp === undefined) return { ok: false, reason: 'missing_timestamp' }
  if (!/^[0-9]+$/.test(rawTimestamp)) {
    return { ok: false, reason: 'malformed_timestamp', detail: rawTimestamp.slice(0, 32) }
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = input.now ?? new Date()
  const time = checkTolerance(Number(rawTimestamp), tolerance, now)
  if (!time.ok) {
    return {
      ok: false,
      reason: time.reason!,
      ...(time.skewSeconds === undefined ? {} : { detail: `${Math.round(time.skewSeconds)}s skew` }),
    }
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`v0:${rawTimestamp}:`, 'utf8'),
    toBuffer(input.rawBody),
  ])

  const candidates = input.secrets.map((secret) => hmacHex(secret, signedPayload))
  const secretIndex = matchAnySignature(candidates, [signature])
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  return {
    ok: true,
    // No delivery id in this scheme either, so the signature serves: it is a
    // function of the timestamp and the body, and a genuine retry of the same
    // event reproduces it exactly.
    dedupKey: signature,
    timestamp: time.timestamp!,
    secretIndex,
  }
}
