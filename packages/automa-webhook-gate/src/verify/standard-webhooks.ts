/**
 * Standard Webhooks.
 *
 *   webhook-id:        msg_abc
 *   webhook-timestamp: 1614556800
 *   webhook-signature: v1,base64sig v1,anotherbase64sig
 *   signed payload:    `${id}.${timestamp}.${rawBody}`
 *
 * Three details that differ from the others and are easy to get wrong:
 *
 * **The signature list is space-delimited**, each entry `version,signature`.
 * Multiple entries exist for zero-downtime rotation, exactly as with Stripe.
 *
 * **The secret is base64 with a `whsec_` prefix.** The HMAC key is the
 * *decoded bytes*, not the printable string. Hashing the string produces a
 * signature that is stable, plausible, and wrong against every real sender —
 * and the failure looks identical to a wrong secret, which is why it is worth
 * handling explicitly rather than leaving to whoever configures it.
 *
 * **`v1a` is ed25519, not HMAC.** Verifying an asymmetric signature with a
 * symmetric comparison is not possible, so those entries are skipped rather
 * than silently treated as `v1` — accepting them by mistake would be a
 * downgrade to an algorithm we are not actually checking.
 *
 * The spec deliberately names no tolerance; five minutes matches the rest.
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

/** `whsec_`-prefixed base64 keys are decoded; anything else is used as-is. */
export function decodeSecret(secret: string): Buffer {
  const body = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  const decoded = Buffer.from(body, 'base64')
  // A round-trip check: if it does not re-encode to the same text it was never
  // base64, and the raw bytes are the better guess.
  if (decoded.toString('base64').replace(/=+$/, '') === body.replace(/=+$/, '')) {
    return decoded
  }
  return Buffer.from(secret, 'utf8')
}

export interface ParsedSignatures {
  /** HMAC-SHA256 signatures we can check. */
  readonly v1: readonly string[]
  /** Versions present but not verifiable here, notably ed25519 `v1a`. */
  readonly skippedVersions: readonly string[]
}

export function parseSignatureHeader(value: string): ParsedSignatures {
  const v1: string[] = []
  const skipped = new Set<string>()

  for (const entry of value.split(' ')) {
    if (entry.length === 0) continue
    const comma = entry.indexOf(',')
    if (comma === -1) {
      skipped.add('malformed')
      continue
    }
    const version = entry.slice(0, comma)
    const signature = entry.slice(comma + 1)
    if (version === 'v1') v1.push(signature)
    else skipped.add(version)
  }

  return { v1, skippedVersions: [...skipped] }
}

export function verifyStandardWebhooks(input: VerifyInput): VerificationResult {
  const failed = preflight(input)
  if (failed !== null) return failed

  const id = header(input.headers, 'webhook-id')
  if (id === undefined || id.length === 0) {
    return { ok: false, reason: 'malformed_signature', detail: 'webhook-id is required' }
  }

  const rawTimestamp = header(input.headers, 'webhook-timestamp')
  if (rawTimestamp === undefined) return { ok: false, reason: 'missing_timestamp' }
  if (!/^[0-9]+$/.test(rawTimestamp)) {
    return { ok: false, reason: 'malformed_timestamp', detail: rawTimestamp.slice(0, 32) }
  }

  const presented = header(input.headers, 'webhook-signature')
  if (presented === undefined) return { ok: false, reason: 'missing_signature' }

  const parsed = parseSignatureHeader(presented)
  if (parsed.v1.length === 0) {
    return {
      ok: false,
      reason: 'unsupported_algorithm',
      detail:
        parsed.skippedVersions.length > 0
          ? `only unsupported versions present: ${parsed.skippedVersions.join(', ')}`
          : 'no v1 signature',
    }
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
    Buffer.from(`${id}.${rawTimestamp}.`, 'utf8'),
    toBuffer(input.rawBody),
  ])

  const candidates = input.secrets.map((secret) =>
    hmacBase64(decodeSecret(secret), signedPayload),
  )
  const secretIndex = matchAnySignature(candidates, parsed.v1)
  if (secretIndex === -1) return { ok: false, reason: 'signature_mismatch' }

  // This scheme does carry a message id, which is a better dedup key than a
  // signature: it stays stable even if the sender re-signs during rotation.
  return { ok: true, dedupKey: id, timestamp: time.timestamp!, secretIndex }
}
