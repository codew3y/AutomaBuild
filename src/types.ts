/**
 * The shapes the engine works in.
 *
 * v1 is linear chains only. Branching and loops are deliberately out of scope
 * until the linear engine is proven, because their interaction with retry,
 * cancellation and concurrency is not obvious and is best not guessed at.
 * `iterationIndex` exists throughout anyway — retrofitting it into the step
 * identity later would mean rewriting every partition.
 */

import type { FlowEdge } from './branching.ts'

export type { FlowEdge }

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
  /**
   * Every step, in topological order.
   *
   * Order still decides what runs next: the orchestrator takes the lowest
   * unfinished step. `edges` does not change that — it exists so a branch can
   * work out which steps its untaken arm abandons.
   */
  readonly nodes: readonly FlowNode[]
  /**
   * How the steps connect.
   *
   * Optional, and absent means a straight chain in `nodes` order — which is
   * what every flow was before branching existed, and still the common case.
   * Required as soon as a `branch` step is present, because without it there
   * is no way to know what the arms lead to.
   */
  readonly edges?: readonly FlowEdge[]
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
  readonly cancelledAtStepId: string | null
  readonly stepCount: number
  readonly stepsSucceeded: number
  readonly stepsFailed: number
  readonly errorClass: string | null
  readonly errorCode: string | null
  /**
   * What the run was started with — the webhook body, typically.
   *
   * On the run rather than on the first step, because it belongs to the run:
   * a resume re-reads it, and putting it on a step would mean a resumed run
   * whose first step was skipped could not see what triggered it.
   */
  readonly input: unknown
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

  /** When the step was first claimed. Not reset by a retry. */
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
  /**
   * Elapsed time from the first claim to the finish.
   *
   * Wall clock, so it includes the waiting between retries, not just the
   * attempt that eventually worked. That is the number that answers "why was
   * this run slow" — a step that succeeded on its fourth try after two minutes
   * of backoff took two minutes, however brief the successful call was.
   */
  readonly durationMs: number | null
}

export type OutboxTopic = 'advance_run' | 'run_step'

export interface OutboxMessage {
  readonly id: string
  readonly topic: OutboxTopic
  readonly payload: Record<string, unknown>
  readonly tenantId: string | null
  readonly attempts: number
}
