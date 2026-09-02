/**
 * Idempotency keys.
 *
 *   key = sha256(run_id ‖ node_id ‖ iteration_index ‖ attempt_group)
 *
 * The whole design rests on what is *absent* from that expression: the attempt
 * number. An automatic retry of a step that may already have succeeded must
 * present the **same** key, so the provider recognises it and declines to act
 * twice. If the attempt number were in the key, every retry would look like
 * fresh intent and duplicate the effect — which is exactly the bug this engine
 * exists to not have.
 *
 * `attempt_group` is the deliberate escape hatch. It increments only when a
 * human asks for a replay. That is genuinely new intent: they have looked at
 * the failure and decided it should happen again.
 *
 *   automatic retry  → same key   → provider deduplicates
 *   operator replay  → new key    → provider acts again, as asked
 */

import { createHash } from 'node:crypto'

export interface StepIdentity {
  readonly runId: string
  readonly nodeId: string
  /** Loop fan-out position. Zero for a step that runs once. */
  readonly iterationIndex: number
  /** Bumped only by a user-initiated replay, never by an automatic retry. */
  readonly attemptGroup: number
}

/**
 * A separator that cannot appear in any component.
 *
 * Without it, `('run1', 'a-b')` and `('run1-a', 'b')` hash identically — a
 * collision between two different steps, which would make one silently
 * deduplicate against the other. A NUL byte cannot occur in a UUID, a node id,
 * or a decimal integer.
 */
const SEPARATOR = '\u0000'

export function stepIdempotencyKey(identity: StepIdentity): string {
  assertIdentityValid(identity)
  const material = [
    identity.runId,
    identity.nodeId,
    String(identity.iterationIndex),
    String(identity.attemptGroup),
  ].join(SEPARATOR)
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

function assertIdentityValid(identity: StepIdentity): void {
  for (const [field, value] of [
    ['runId', identity.runId],
    ['nodeId', identity.nodeId],
  ] as const) {
    if (value.length === 0) {
      throw new RangeError(`${field} must not be empty`)
    }
    if (value.includes(SEPARATOR)) {
      throw new RangeError(`${field} must not contain a NUL byte`)
    }
  }
  for (const [field, value] of [
    ['iterationIndex', identity.iterationIndex],
    ['attemptGroup', identity.attemptGroup],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RangeError(`${field} must be a non-negative integer, got ${value}`)
    }
  }
}

/**
 * The key for a replay: same step, new intent.
 *
 * Kept as a named function rather than leaving callers to increment the field
 * themselves, so that "this is a new side effect" is an explicit act at every
 * call site.
 */
export function replayKey(identity: StepIdentity): { key: string; identity: StepIdentity } {
  const next: StepIdentity = { ...identity, attemptGroup: identity.attemptGroup + 1 }
  return { key: stepIdempotencyKey(next), identity: next }
}

/**
 * Dedup key for an inbound trigger event.
 *
 * Prefer the provider's own event id — it is stable across their retries. Fall
 * back to hashing timestamp and body, which catches a redelivery of a byte
 * identical payload but cannot catch a genuine duplicate the provider gave two
 * different ids.
 */
export function triggerDedupKey(input: {
  endpointId: string
  providerEventId?: string | null
  timestamp?: string
  body?: string
}): string {
  if (input.providerEventId !== undefined && input.providerEventId !== null && input.providerEventId.length > 0) {
    return createHash('sha256')
      .update([input.endpointId, 'event', input.providerEventId].join(SEPARATOR), 'utf8')
      .digest('hex')
  }
  return createHash('sha256')
    .update(
      [input.endpointId, 'body', input.timestamp ?? '', input.body ?? ''].join(SEPARATOR),
      'utf8',
    )
    .digest('hex')
}
