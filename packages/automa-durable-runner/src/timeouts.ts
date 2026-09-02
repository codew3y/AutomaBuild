/**
 * The four timeout layers, and the invariant that keeps them honest.
 *
 *   http call  <  step attempt  <  whole run
 *
 * plus, at shutdown:
 *
 *   step attempt  <  drain  <  grace
 *
 * An inversion here is a bug that only appears under load, which is the worst
 * kind. If the step deadline is longer than the shutdown drain window, then
 * every rolling deploy kills steps mid-flight and leaves leases to expire —
 * turning a routine restart into a burst of duplicate work. Nothing in
 * ordinary testing surfaces that, so it is asserted at startup instead.
 */

export interface TimeoutConfig {
  /** One HTTP call: connect + TLS + first byte + body. */
  readonly httpCallMs: number
  /** Expression evaluation — a guard against a pathological expression. */
  readonly expressionMs: number
  /** One step attempt: all internal work plus the call. */
  readonly stepAttemptMs: number
  /** Whole run, wall clock, excluding time spent sleeping between steps. */
  readonly runMs: number
  /** On shutdown, how long we wait for in-flight steps to finish. */
  readonly drainMs: number
  /** After the drain, how long before the process is killed outright. */
  readonly graceMs: number
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  httpCallMs: 30_000,
  expressionMs: 250,
  stepAttemptMs: 60_000,
  runMs: 900_000, // 15 minutes
  drainMs: 90_000,
  graceMs: 120_000,
}

export const TIMEOUT_CEILINGS = {
  httpCallMs: 120_000,
  expressionMs: 1_000,
  stepAttemptMs: 300_000,
  runMs: 3_600_000,
} as const

export class TimeoutConfigError extends Error {
  override readonly name = 'TimeoutConfigError'
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super(`Invalid timeout configuration:\n  - ${violations.join('\n  - ')}`)
    this.violations = violations
  }
}

/**
 * Verify the layering. Call this at process startup, before accepting work.
 *
 * Returns nothing and throws on the first bad configuration, because a worker
 * with inverted timeouts should refuse to start rather than run and corrupt
 * state in ways that only show up as mysterious duplicates a week later.
 */
export function assertTimeoutsValid(config: TimeoutConfig): void {
  const violations: string[] = []

  for (const [field, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value <= 0) {
      violations.push(`${field} must be a positive number, got ${value}`)
    }
  }

  for (const [field, ceiling] of Object.entries(TIMEOUT_CEILINGS)) {
    const value = config[field as keyof TimeoutConfig]
    if (value > ceiling) {
      violations.push(`${field} (${value} ms) exceeds its ceiling of ${ceiling} ms`)
    }
  }

  // A step must be able to contain the call it makes, with room for our own
  // work either side; otherwise the step deadline fires first and every slow
  // call is recorded as our timeout rather than theirs.
  if (config.httpCallMs >= config.stepAttemptMs) {
    violations.push(
      `httpCallMs (${config.httpCallMs}) must be less than stepAttemptMs (${config.stepAttemptMs}), or the step deadline fires before the call can complete`,
    )
  }

  if (config.expressionMs >= config.stepAttemptMs) {
    violations.push(
      `expressionMs (${config.expressionMs}) must be less than stepAttemptMs (${config.stepAttemptMs})`,
    )
  }

  if (config.stepAttemptMs >= config.runMs) {
    violations.push(
      `stepAttemptMs (${config.stepAttemptMs}) must be less than runMs (${config.runMs}), or a single step can consume the entire run budget`,
    )
  }

  // The shutdown chain. A drain shorter than a step attempt guarantees that
  // rolling deploys interrupt work that was about to succeed.
  if (config.stepAttemptMs > config.drainMs) {
    violations.push(
      `stepAttemptMs (${config.stepAttemptMs}) must not exceed drainMs (${config.drainMs}), or every deploy kills steps mid-flight and leaves leases to expire`,
    )
  }

  if (config.drainMs >= config.graceMs) {
    violations.push(
      `drainMs (${config.drainMs}) must be less than graceMs (${config.graceMs}), or the process is killed before the drain can finish`,
    )
  }

  if (violations.length > 0) throw new TimeoutConfigError(violations)
}

/**
 * The deadline for a step attempt, as an absolute instant.
 *
 * Computed from an injected clock so that the executor and the tests agree on
 * what "now" means.
 */
export function stepDeadline(startedAt: number, config: TimeoutConfig): number {
  return startedAt + config.stepAttemptMs
}

/**
 * How long an individual call may take, given how much of the step's budget is
 * already spent.
 *
 * Without this, a step that has burned 55 of its 60 seconds still hands the
 * HTTP client a 30-second timeout, and the step deadline fires mid-call — with
 * the request already sent. That is an `unknown_outcome`, manufactured by our
 * own arithmetic.
 */
export function remainingCallBudgetMs(
  now: number,
  stepStartedAt: number,
  config: TimeoutConfig,
): number {
  const remaining = stepDeadline(stepStartedAt, config) - now
  return Math.max(0, Math.min(config.httpCallMs, remaining))
}
