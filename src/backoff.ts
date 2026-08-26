/**
 * Retry scheduling: Full Jitter, with the provider's opinion taking precedence.
 *
 *   delay = random(0, min(cap, base * 2^(attempt - 1)))
 *
 * AWS measured four strategies and found Full Jitter did the least total work
 * while staying time-competitive. The intuition: exponential backoff alone
 * spreads retries out in *time* but not across *clients* — a thousand steps
 * that failed together retry together, hammering a service that is already
 * unwell. Jitter smears them.
 *
 * Drawing from zero rather than from half the window is deliberate. It means
 * some retries come back very quickly, which is what keeps recovery fast when
 * the fault was momentary.
 */

import type { Random } from './random.ts'

export interface BackoffPolicy {
  /** First-attempt window, before doubling. */
  readonly baseMs: number
  /** Ceiling for the computed window. */
  readonly capMs: number
  /** Total attempts permitted, including the first. */
  readonly maxAttempts: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  capMs: 900_000, // 15 minutes
  maxAttempts: 5,
}

/**
 * The exponential window for an attempt, before jitter.
 *
 * `attempt` is 1-based: the delay *after* attempt 1 has failed uses the base
 * window. Guarded against overflow, because 2^1024 is Infinity and
 * `Math.min(cap, Infinity)` quietly returning the cap is the correct answer
 * for the wrong reason — better to clamp the exponent explicitly.
 */
export function backoffWindowMs(attempt: number, policy: BackoffPolicy): number {
  if (attempt < 1) throw new RangeError(`attempt must be >= 1, got ${attempt}`)
  const exponent = Math.min(attempt - 1, 30)
  const window = policy.baseMs * 2 ** exponent
  return Math.min(policy.capMs, window)
}

export interface RetryDelayInput {
  readonly attempt: number
  readonly policy: BackoffPolicy
  readonly random: Random
  /**
   * Milliseconds the provider asked us to wait, if it said so.
   *
   * This wins whenever it is longer than our own computation. We never back
   * off *less* than asked — that is how an IP ends up blocked — but we do
   * clamp it, so a provider cannot park a worker for a week.
   */
  readonly retryAfterMs?: number | null
}

export interface RetryDelay {
  readonly delayMs: number
  readonly source: 'jitter' | 'retry_after' | 'retry_after_clamped'
}

export function computeRetryDelay(input: RetryDelayInput): RetryDelay {
  const window = backoffWindowMs(input.attempt, input.policy)
  const jittered = Math.floor(input.random() * window)

  const asked = input.retryAfterMs
  if (asked !== undefined && asked !== null && asked > 0) {
    if (asked > input.policy.capMs) {
      return { delayMs: input.policy.capMs, source: 'retry_after_clamped' }
    }
    // Only defer to the provider when it wants us to wait longer than we would.
    if (asked > jittered) {
      return { delayMs: asked, source: 'retry_after' }
    }
  }

  return { delayMs: jittered, source: 'jitter' }
}

/**
 * Whether another attempt is permitted.
 *
 * `attemptsConsumed` counts only failures that the classification table says
 * should count — a step can be rate-limited twenty times and still have all
 * five of its attempts intact.
 */
export function attemptsRemaining(attemptsConsumed: number, policy: BackoffPolicy): number {
  return Math.max(0, policy.maxAttempts - attemptsConsumed)
}

/**
 * The worst-case total wait across a full ladder, for documentation and for
 * asserting a policy is sane at startup.
 *
 * Uses the un-jittered window, since Full Jitter can only draw below it.
 */
export function worstCaseLadderMs(policy: BackoffPolicy): number {
  let total = 0
  for (let attempt = 1; attempt < policy.maxAttempts; attempt++) {
    total += backoffWindowMs(attempt, policy)
  }
  return total
}

export function assertPolicyValid(policy: BackoffPolicy): void {
  if (policy.baseMs <= 0) throw new RangeError('baseMs must be positive')
  if (policy.capMs < policy.baseMs) {
    throw new RangeError(`capMs (${policy.capMs}) must be >= baseMs (${policy.baseMs})`)
  }
  if (policy.maxAttempts < 1) throw new RangeError('maxAttempts must be >= 1')
}
