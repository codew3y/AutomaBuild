/**
 * The per-step retry state machine.
 *
 * This is where the classification table, the backoff policy and the clock
 * meet. Given "attempt N failed, and here is what we know about the failure",
 * it answers exactly one question: what happens to this step now?
 *
 * It is deliberately pure — no database, no queue, no I/O. The executor is
 * responsible for persisting the outcome; this decides what the outcome is.
 * That split is what makes a five-attempt ladder a single synchronous test
 * rather than a half-hour of waiting.
 */

import {
  type BackoffPolicy,
  DEFAULT_BACKOFF,
  computeRetryDelay,
  attemptsRemaining,
} from './backoff.ts'
import { type ErrorClass, type ErrorAction, decideRetry } from './error-classes.ts'
import type { Random } from './random.ts'

export interface StepRetryState {
  /** Attempts started so far, including the one that just failed. */
  readonly attemptsStarted: number
  /**
   * Attempts that count against the budget.
   *
   * Diverges from `attemptsStarted` whenever a failure was the provider's
   * availability rather than our request — rate limits, token expiry.
   */
  readonly attemptsConsumed: number
}

export const INITIAL_RETRY_STATE: StepRetryState = {
  attemptsStarted: 0,
  attemptsConsumed: 0,
}

export type RetryOutcome =
  | {
      readonly kind: 'retry'
      /** Absolute instant, from the injected clock. Goes in `next_attempt_at`. */
      readonly nextAttemptAt: number
      readonly delayMs: number
      readonly delaySource: 'jitter' | 'retry_after' | 'retry_after_clamped'
      readonly state: StepRetryState
      readonly reason: string
    }
  | {
      readonly kind: 'exhausted'
      /** Attempts are gone but the class was retryable — this is a DLQ case. */
      readonly state: StepRetryState
      readonly reason: string
    }
  | {
      readonly kind: 'terminal'
      readonly action: ErrorAction
      readonly state: StepRetryState
      readonly reason: string
    }

export interface AttemptFailure {
  readonly errorClass: ErrorClass
  /** Whether repeating this specific call is safe. Resolves the conditional rows. */
  readonly idempotent: boolean
  /** Parsed from the provider's `Retry-After`, if it sent one. */
  readonly retryAfterMs?: number | null
}

export interface RetryDeps {
  readonly now: number
  readonly random: Random
  readonly policy?: BackoffPolicy
}

/**
 * Decide what happens after a failed attempt.
 *
 * The order of the checks matters:
 *
 * 1. Is this class retryable at all? A `client_error` is wrong on attempt one
 *    and wrong on attempt five; spending attempts on it helps nobody.
 * 2. Does it consume an attempt? Applied *before* the budget check, so a step
 *    that is rate-limited repeatedly never exhausts itself.
 * 3. Is there budget left?
 */
export function onAttemptFailed(
  state: StepRetryState,
  failure: AttemptFailure,
  deps: RetryDeps,
): RetryOutcome {
  const policy = deps.policy ?? DEFAULT_BACKOFF
  const decision = decideRetry(failure.errorClass, { idempotent: failure.idempotent })

  const consumed = state.attemptsConsumed + (decision.consumesAttempt ? 1 : 0)
  const next: StepRetryState = {
    attemptsStarted: state.attemptsStarted,
    attemptsConsumed: consumed,
  }

  if (!decision.retry) {
    return {
      kind: 'terminal',
      action: decision.action,
      state: next,
      reason: decision.reason,
    }
  }

  if (attemptsRemaining(consumed, policy) === 0) {
    return {
      kind: 'exhausted',
      state: next,
      reason: `all ${policy.maxAttempts} attempts consumed; last failure was ${failure.errorClass}`,
    }
  }

  // The window is sized on consumed attempts, not on attempts started. A step
  // that was rate-limited nine times and has failed once for real is early in
  // its ladder, not deep into it, and should not wait as though it were.
  //
  // `consumed` is passed directly, not `consumed + 1`: after the first real
  // failure the step waits one base window, so the exponent is zero. Passing
  // the next attempt's number instead doubles every delay in the ladder.
  const delay = computeRetryDelay({
    attempt: Math.max(1, consumed),
    policy,
    random: deps.random,
    retryAfterMs: failure.retryAfterMs ?? null,
  })

  return {
    kind: 'retry',
    nextAttemptAt: deps.now + delay.delayMs,
    delayMs: delay.delayMs,
    delaySource: delay.source,
    state: next,
    reason: decision.reason,
  }
}

/** Record that an attempt is beginning. */
export function onAttemptStarted(state: StepRetryState): StepRetryState {
  return { ...state, attemptsStarted: state.attemptsStarted + 1 }
}

/**
 * Run a whole ladder against a scripted sequence of failures.
 *
 * Exists for tests and for documentation: it is how the retry behaviour is
 * asserted in one synchronous pass, and how a policy change can be inspected
 * without deploying anything.
 */
export function simulateLadder(input: {
  failures: readonly AttemptFailure[]
  random: Random
  policy?: BackoffPolicy
  startAt?: number
}): { outcomes: RetryOutcome[]; finalState: StepRetryState; totalDelayMs: number } {
  let state = INITIAL_RETRY_STATE
  let now = input.startAt ?? 0
  let totalDelayMs = 0
  const outcomes: RetryOutcome[] = []

  for (const failure of input.failures) {
    state = onAttemptStarted(state)
    const outcome = onAttemptFailed(state, failure, {
      now,
      random: input.random,
      ...(input.policy === undefined ? {} : { policy: input.policy }),
    })
    outcomes.push(outcome)
    state = outcome.state
    if (outcome.kind !== 'retry') break
    totalDelayMs += outcome.delayMs
    now = outcome.nextAttemptAt
  }

  return { outcomes, finalState: state, totalDelayMs }
}
