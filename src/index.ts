/**
 * The pure core: everything the engine decides before it touches a database.
 *
 * Nothing exported here performs I/O, reads the wall clock, or calls
 * `Math.random()`. That is what lets a five-attempt retry ladder spanning half
 * an hour be asserted in a single synchronous test.
 */

export { type Clock, type Millis, SystemClock, FakeClock } from './clock.ts'
export { type Random, systemRandom, seededRandom, alwaysRandom } from './random.ts'

export {
  type ErrorClass,
  type ErrorClassSpec,
  type ErrorAction,
  type Retryability,
  type RetryContext,
  type RetryDecision,
  ERROR_CLASSES,
  specFor,
  decideRetry,
  isTerminal,
} from './error-classes.ts'

export { type FailureFacts, classify, parseRetryAfter } from './classify.ts'

export {
  type BackoffPolicy,
  type RetryDelay,
  type RetryDelayInput,
  DEFAULT_BACKOFF,
  backoffWindowMs,
  computeRetryDelay,
  attemptsRemaining,
  worstCaseLadderMs,
  assertPolicyValid,
} from './backoff.ts'

export {
  type StepRetryState,
  type RetryOutcome,
  type AttemptFailure,
  type RetryDeps,
  INITIAL_RETRY_STATE,
  onAttemptStarted,
  onAttemptFailed,
  simulateLadder,
} from './retry.ts'

export {
  type StepIdentity,
  stepIdempotencyKey,
  replayKey,
  triggerDedupKey,
} from './idempotency.ts'

export {
  type TimeoutConfig,
  DEFAULT_TIMEOUTS,
  TIMEOUT_CEILINGS,
  TimeoutConfigError,
  assertTimeoutsValid,
  stepDeadline,
  remainingCallBudgetMs,
} from './timeouts.ts'
