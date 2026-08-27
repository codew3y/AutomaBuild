/**
 * automa-durable-runner — a multi-step task engine that does not lose work
 * when a machine dies, and does not repeat work it has already done.
 *
 * Two layers, exported together but worth telling apart.
 *
 * **The pure core** decides things: which error class a failure belongs to,
 * whether to retry and when, what a step's idempotency key is, whether a
 * timeout configuration is coherent. None of it performs I/O, reads the wall
 * clock, or calls `Math.random()` — which is what lets a five-attempt retry
 * ladder spanning half an hour be asserted in a single synchronous test.
 *
 * **The engine** does things: claims leases, executes steps, records outcomes,
 * recovers what a dead worker abandoned. It calls into the core for every
 * decision, so there is one implementation of each rule rather than one in the
 * tests and another in production.
 */

/* ------------------------------------------------------------- pure core */

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

/* ----------------------------------------------------------------- types */

export {
  type FlowDefinition,
  type FlowNode,
  type RunRow,
  type RunStatus,
  type StepRow,
  type StepStatus,
  type OutboxMessage,
  type OutboxTopic,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
} from './types.ts'

/* -------------------------------------------------------------- database */

export { type DbConfig, dbConfigFromEnv } from './db/config.ts'
export { type Executor, createPool, withTransaction } from './db/client.ts'
export {
  type Migration,
  type MigrationResult,
  MigrationDriftError,
  loadMigrations,
  migrate,
} from './db/migrate.ts'

/* ---------------------------------------------------------------- engine */

export {
  type ClaimInput,
  type ClaimResult,
  type ConcurrencyLimits,
  type CreateRunInput,
  type CreateRunResult,
  type DlqInput,
  type EnqueueInput,
  type RecordFailureInput,
  claimOutboxBatch,
  claimStep,
  createRun,
  deferOutbox,
  deleteOutbox,
  enqueue,
  getRun,
  listDlqEntries,
  listSteps,
  nextRunnableStep,
  recordFailure,
  recordSuccess,
  renewLease,
  requestCancel,
  setRunStatus,
  writeDlqEntry,
} from './engine/repository.ts'

export {
  type StepContext,
  type StepHandler,
  type StepResult,
  type HandlerRegistry,
  type HttpStepConfig,
  StepFailure,
  defaultHandlers,
  httpHandler,
  noopHandler,
  scriptedHandler,
} from './engine/handlers.ts'

export { type AdvanceOutcome, type RunRef, advanceRun } from './engine/orchestrator.ts'
export { type ExecutorDeps, type RunStepInput, type StepOutcome, runStep } from './engine/executor.ts'

export {
  type DrainOptions,
  type DrainReport,
  advanceClock,
  drainQueue,
  drainUntilQuiet,
} from './engine/drain.ts'

export {
  type PartitionHealth,
  type SweepOptions,
  type SweepReport,
  PARTITION_HEADROOM_WARNING_DAYS,
  assertPartitionHeadroom,
  partitionHealth,
  sweep,
} from './engine/janitor.ts'

export {
  type ResumeInput,
  type ResumeResult,
  ResumeError,
  replayDlqEntry,
  resumeRun,
} from './engine/resume.ts'

export {
  type Worker,
  type WorkerEvent,
  type WorkerOptions,
  installSignalHandlers,
  startWorker,
} from './engine/worker.ts'
