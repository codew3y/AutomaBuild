/**
 * Resume-from-step, and DLQ replay.
 *
 * Resume is a query, not a feature. Because every step's status, input and
 * output are persisted independently, "run this again from step three" is a
 * matter of deciding which rows to reset — there is no replay log to rewind
 * and no state to reconstruct.
 *
 * Two decisions carry the weight:
 *
 * **Earlier steps keep their outputs.** They are marked `skipped_resumed`
 * rather than reset, so downstream expressions that reference them still
 * resolve. A resume that discarded them would fail at the first mapping, and
 * the obvious fix — re-running them — is exactly what the operator asked not
 * to happen.
 *
 * **Resumed steps get a new attempt group.** That changes their idempotency
 * keys, which is the point: an automatic retry says "this may already have
 * happened, please deduplicate", while an operator replay says "do it again,
 * I have looked at it and I mean it". Reusing the old key would make the
 * provider decline the very work that was asked for.
 */

import type { Executor } from '../db/client.ts'
import { stepIdempotencyKey } from '../idempotency.ts'
import { enqueue, getRun, listSteps } from './repository.ts'
import type { RunRow, StepRow } from '../types.ts'

export interface ResumeInput {
  readonly runId: string
  readonly runStartedAt: Date
  /**
   * The node to resume from. Everything before it is preserved and skipped;
   * it and everything after are reset to pending.
   */
  readonly fromNodeId: string
}

export interface ResumeResult {
  readonly run: RunRow
  readonly attemptGroup: number
  readonly skipped: readonly string[]
  readonly reset: readonly string[]
}

export class ResumeError extends Error {
  override readonly name = 'ResumeError'
}

export async function resumeRun(tx: Executor, input: ResumeInput): Promise<ResumeResult> {
  const run = await getRun(tx, input.runStartedAt, input.runId)
  if (run === null) throw new ResumeError(`run ${input.runId} does not exist`)

  // Resuming a run that is still going would race the worker already on it.
  if (!['failed', 'cancelled', 'timed_out', 'waiting_confirmation'].includes(run.status)) {
    throw new ResumeError(
      `run ${input.runId} is ${run.status}; only a stopped run can be resumed`,
    )
  }

  const steps = await listSteps(tx, { id: run.id, startedAt: run.startedAt })
  const target = steps.find((step) => step.nodeId === input.fromNodeId)
  if (target === undefined) {
    throw new ResumeError(
      `run ${input.runId} has no step ${JSON.stringify(input.fromNodeId)}`,
    )
  }

  const attemptGroup = run.attemptGroup + 1
  await tx.query(
    `UPDATE runs
        SET attempt_group = $3,
            status = 'queued',
            finished_at = NULL,
            error_class = NULL,
            error_code = NULL,
            error_step_id = NULL,
            cancel_requested_at = NULL,
            cancelled_at_step_id = NULL
      WHERE started_at = $1 AND id = $2`,
    [run.startedAt, run.id, attemptGroup],
  )

  const skipped: string[] = []
  const reset: string[] = []

  for (const step of steps) {
    if (step.topoOrder < target.topoOrder) {
      await markSkipped(tx, step)
      skipped.push(step.nodeId)
      continue
    }
    await resetStep(tx, step, attemptGroup)
    reset.push(step.nodeId)
  }

  await tx.query(
    `UPDATE runs
        SET steps_succeeded = 0, steps_failed = 0
      WHERE started_at = $1 AND id = $2`,
    [run.startedAt, run.id],
  )

  await enqueue(tx, {
    topic: 'advance_run',
    payload: { runId: run.id, runStartedAt: run.startedAt.toISOString() },
    tenantId: run.tenantId,
  })

  const updated = await getRun(tx, input.runStartedAt, input.runId)
  return { run: updated!, attemptGroup, skipped, reset }
}

/**
 * Preserve a step that ran before the resume point.
 *
 * `output_inline` is deliberately left alone. That output is the input to
 * everything downstream, and the whole reason resume-from-step is possible is
 * that it was persisted rather than held in a worker's memory.
 */
async function markSkipped(tx: Executor, step: StepRow): Promise<void> {
  await tx.query(
    `UPDATE step_executions
        SET status = 'skipped_resumed',
            lease_expires_at = NULL,
            next_attempt_at = NULL,
            worker_id = NULL
      WHERE run_started_at = $1 AND id = $2`,
    [step.runStartedAt, step.id],
  )
}

/**
 * Return a step to pending with a fresh identity.
 *
 * Counters go back to zero — this is a new attempt group, and carrying the old
 * exhaustion forward would mean a replay that fails immediately without trying.
 * The idempotency key is recomputed from the new group, so the provider treats
 * this as new intent rather than a duplicate of the original.
 */
async function resetStep(tx: Executor, step: StepRow, attemptGroup: number): Promise<void> {
  const idempotencyKey = stepIdempotencyKey({
    runId: step.runId,
    nodeId: step.nodeId,
    iterationIndex: step.iterationIndex,
    attemptGroup,
  })

  await tx.query(
    `UPDATE step_executions
        SET status = 'pending',
            idempotency_key = $3,
            attempts_started = 0,
            attempts_consumed = 0,
            deferrals = 0,
            next_attempt_at = NULL,
            lease_expires_at = NULL,
            worker_id = NULL,
            output_inline = NULL,
            output_ref = NULL,
            output_preview = NULL,
            error_class = NULL,
            error_code = NULL,
            error_message = NULL,
            http_status = NULL,
            started_at = NULL,
            finished_at = NULL,
            duration_ms = NULL
      WHERE run_started_at = $1 AND id = $2`,
    [step.runStartedAt, step.id, idempotencyKey],
  )
}

/**
 * Replay a dead-lettered step.
 *
 * Resumes the original run from the node that failed, and records the replay
 * on the DLQ entry so the same failure is not worked twice by two people.
 */
export async function replayDlqEntry(
  tx: Executor,
  dlqEntryId: string,
  replayedBy?: string,
): Promise<ResumeResult> {
  const { rows } = await tx.query<{
    run_id: string | null
    run_started_at: Date | null
    node_id: string | null
    replayed_at: Date | null
  }>(
    `SELECT run_id, run_started_at, node_id, replayed_at
       FROM dlq_entries WHERE id = $1`,
    [dlqEntryId],
  )
  const entry = rows[0]
  if (entry === undefined) throw new ResumeError(`no DLQ entry ${dlqEntryId}`)
  if (entry.replayed_at !== null) {
    throw new ResumeError(`DLQ entry ${dlqEntryId} was already replayed`)
  }
  if (entry.run_id === null || entry.run_started_at === null || entry.node_id === null) {
    throw new ResumeError(`DLQ entry ${dlqEntryId} does not identify a step to replay`)
  }

  const result = await resumeRun(tx, {
    runId: entry.run_id,
    runStartedAt: entry.run_started_at,
    fromNodeId: entry.node_id,
  })

  await tx.query(
    `UPDATE dlq_entries
        SET replayed_at = now(), replayed_run_id = $2, resolved_at = now(), resolved_by = $3
      WHERE id = $1`,
    [dlqEntryId, result.run.id, replayedBy ?? null],
  )

  return result
}
