/**
 * The gate: verify, then check for a replay, then hand off.
 *
 * Order matters, and it is the opposite of what seems efficient. The signature
 * is checked *before* the replay store is touched, so an unauthenticated
 * request never writes a row — otherwise anyone who can reach the endpoint
 * could fill the table, and worse, could poison a legitimate delivery's key by
 * claiming it first with a forged signature.
 *
 * What this deliberately does not do is anything with the payload. It hands
 * back a verified, de-duplicated event and stops. Turning that into work
 * belongs to whatever consumes it.
 */

import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TOLERANCE_SECONDS,
  type VerificationResult,
  type VerifyInput,
} from './verify/common.ts'
import { verifyStripe } from './verify/stripe.ts'
import { verifyGitHub } from './verify/github.ts'
import { verifySlack } from './verify/slack.ts'
import { verifyStandardWebhooks } from './verify/standard-webhooks.ts'
import { verifyTally } from './verify/tally.ts'
import {
  assertRetentionCoversTolerance,
  type DeliveryOutcome,
  type ReplayStore,
} from './replay/store.ts'

/**
 * Every scheme, in one place.
 *
 * The list was written out separately in five files — this one, the
 * application's config, two of its routes and the editor — so adding a
 * scheme meant finding all five, and missing one produced a scheme that
 * verified correctly and could not be selected.
 */
export const SCHEMES = ['stripe', 'github', 'slack', 'standard', 'tally'] as const

export type Scheme = (typeof SCHEMES)[number]

/** The header each scheme presents its signature in. */
export const SIGNATURE_HEADERS: Record<Scheme, string> = {
  stripe: 'Stripe-Signature',
  github: 'X-Hub-Signature-256',
  slack: 'X-Slack-Signature',
  standard: 'webhook-signature',
  tally: 'Tally-Signature',
}

/** True when the value names a scheme this verifies. */
export function isScheme(value: string): value is Scheme {
  return (SCHEMES as readonly string[]).includes(value)
}

const VERIFIERS: Record<Scheme, (input: VerifyInput) => VerificationResult> = {
  stripe: verifyStripe,
  github: verifyGitHub,
  slack: verifySlack,
  standard: verifyStandardWebhooks,
  tally: verifyTally,
}

export interface EndpointConfig {
  readonly endpointId: string
  readonly scheme: Scheme
  /** Every currently-valid secret. More than one during rotation. */
  readonly secrets: readonly string[]
  readonly toleranceSeconds?: number
  readonly maxBodyBytes?: number
}

export interface GateRequest {
  readonly rawBody: Buffer | string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly method?: string
  readonly now?: Date
}

export type GateResult =
  | {
      readonly status: 200
      readonly outcome: 'accepted'
      readonly dedupKey: string
      readonly timestamp?: Date
      readonly secretIndex: number
    }
  | {
      readonly status: 200
      readonly outcome: 'duplicate'
      readonly dedupKey: string
      readonly originallyAt?: Date
    }
  | {
      readonly status: 400 | 401 | 405 | 413
      readonly outcome: Exclude<DeliveryOutcome, 'accepted' | 'duplicate'>
      readonly reason: string
    }

/** Methods a webhook may legitimately arrive by. */
const ALLOWED_METHODS = new Set(['POST', 'PUT'])

export interface GateOptions {
  readonly store: ReplayStore
  /** Retention of the store, asserted against the tolerance at construction. */
  readonly retentionSeconds?: number
}

export function createGate(options: GateOptions) {
  return async function gate(
    endpoint: EndpointConfig,
    request: GateRequest,
  ): Promise<GateResult> {
    const tolerance = endpoint.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    if (options.retentionSeconds !== undefined) {
      // A store that forgets faster than a request stays valid is not replay
      // protection — there is a window in which a captured request is both
      // inside its tolerance and no longer remembered.
      assertRetentionCoversTolerance(options.retentionSeconds, tolerance)
    }

    const method = (request.method ?? 'POST').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      return { status: 405, outcome: 'rejected_signature', reason: `method ${method}` }
    }

    const verified = VERIFIERS[endpoint.scheme]({
      rawBody: request.rawBody,
      headers: request.headers,
      secrets: endpoint.secrets,
      toleranceSeconds: tolerance,
      maxBodyBytes: endpoint.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      ...(request.now === undefined ? {} : { now: request.now }),
    })

    if (!verified.ok) {
      if (verified.reason === 'body_too_large') {
        return { status: 413, outcome: 'rejected_size', reason: verified.reason }
      }
      if (
        verified.reason === 'timestamp_outside_tolerance' ||
        verified.reason === 'malformed_timestamp' ||
        verified.reason === 'missing_timestamp'
      ) {
        return { status: 400, outcome: 'rejected_timestamp', reason: verified.reason }
      }
      // Everything else is an authentication failure. The reason is returned
      // for logging but should not be echoed to the caller in detail: telling
      // an attacker whether their signature was malformed or merely wrong is
      // free information.
      return { status: 401, outcome: 'rejected_signature', reason: verified.reason }
    }

    const receivedAt = request.now ?? new Date()
    const seen = await options.store.record({
      endpointId: endpoint.endpointId,
      dedupKey: verified.dedupKey,
      outcome: 'accepted',
      receivedAt,
    })

    if (!seen.first) {
      // 200, not an error. A sender retrying because it never saw our response
      // is behaving correctly, and a 4xx would make it retry harder.
      return {
        status: 200,
        outcome: 'duplicate',
        dedupKey: verified.dedupKey,
        ...(seen.originallyAt === undefined ? {} : { originallyAt: seen.originallyAt }),
      }
    }

    return {
      status: 200,
      outcome: 'accepted',
      dedupKey: verified.dedupKey,
      ...(verified.timestamp === undefined ? {} : { timestamp: verified.timestamp }),
      secretIndex: verified.secretIndex,
    }
  }
}
