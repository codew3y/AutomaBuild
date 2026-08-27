/**
 * The shapes the engine works in.
 *
 * v1 is linear chains only. Branching and loops are deliberately out of scope
 * until the linear engine is proven, because their interaction with retry,
 * cancellation and concurrency is not obvious and is best not guessed at.
 * `iterationIndex` exists throughout anyway — retrofitting it into the step
 * identity later would mean rewriting every partition.
 */

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_confirmation'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'

export type StepStatus =
  | 'pending'
  | 'dispatched'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'skipped_resumed'
  | 'cancelled'
  | 'timed_out'
  | 'waiting_confirmation'

/** Statuses from which a run will never move again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

export interface FlowNode {
  readonly id: string
  /** Which executor handles it. v1 ships `http` and `noop`. */
  readonly kind: string
  /** Whether repeating this call is safe. Decides the conditional error rows. */
  readonly idempotent: boolean
  readonly config?: Record<string, unknown>
  readonly maxAttempts?: number
}

export interface FlowDefinition {
  readonly id: string
  readonly versionId: string
  /** Executed in order. A linear chain, by construction. */
  readonly nodes: readonly FlowNode[]
}

export interface RunRow {
  readonly id: string
  readonly tenantId: string
  readonly flowId: string
  readonly flowVersionId: string
  readonly status: RunStatus
  readonly attemptGroup: number
  readonly startedAt: Date
  readonly finishedAt: Date | null
  readonly deadlineAt: Date | null
  readonly cancelRequestedAt: Date | null
  readonly stepCount: number
  readonly stepsSucceeded: number
  readonly stepsFailed: number
  readonly errorClass: string | null
  readonly errorCode: string | null
}

export interface StepRow {
  readonly id: string
  readonly tenantId: string
  readonly runId: string
  readonly runStartedAt: Date
  readonly nodeId: string
  readonly iterationIndex: number
  readonly topoOrder: number
  readonly stepKind: string
  readonly status: StepStatus
  readonly attemptsStarted: number
  readonly attemptsConsumed: number
  readonly deferrals: number
  readonly maxAttempts: number
  readonly maxDeferrals: number
  readonly nextAttemptAt: Date | null
  readonly idempotencyKey: string
  readonly leaseExpiresAt: Date | null
  readonly workerId: string | null
  readonly inputInline: unknown
  readonly outputInline: unknown
  readonly errorClass: string | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
}

export type OutboxTopic = 'advance_run' | 'run_step'

export interface OutboxMessage {
  readonly id: string
  readonly topic: OutboxTopic
  readonly payload: Record<string, unknown>
  readonly tenantId: string | null
  readonly attempts: number
}
