/**
 * The orchestrator decides what happens next. It never calls a third party.
 *
 * That restriction is the whole design. Everything here is a short, purely
 * local transaction — read the run, work out the next step, write an outbox
 * row — so it can be fast, and so a slow provider can never block the
 * component that decides whether runs progress. All the waiting happens in the
 * executor, where it belongs.
 */

import type { Pool } from 'pg'
import { withTransaction } from '../db/client.ts'
import {
  enqueue,
  getRun,
  listSteps,
  nextRunnableStep,
  setRunStatus,
} from './repository.ts'
import { isTerminalRunStatus, type RunRow } from '../types.ts'

export interface RunRef {
  readonly runId: string
  readonly runStartedAt: Date
}

export type AdvanceOutcome =
  | { readonly kind: 'dispatched'; readonly stepId: string; readonly nodeId: string }
  | { readonly kind: 'waiting'; readonly reason: string }
  | { readonly kind: 'finished'; readonly status: RunRow['status'] }
  | { readonly kind: 'gone' }

/**
 * Move a run forward by at most one step.
 *
 * Checks, in order, and the order matters:
 *
 * 1. Already terminal — a duplicate `advance_run` message must be a no-op, not
 *    a resurrection.
 * 2. Cancellation — checked at *every* transition, which is what makes
 *    cooperative cancellation actually stop things.
 * 3. Deadline — a run that has outlived its budget stops here rather than
 *    starting another step it has no time to finish.
 * 4. The next runnable step, if there is one.
 */
export async function advanceRun(pool: Pool, ref: RunRef): Promise<AdvanceOutcome> {
  return withTransaction(pool, async (tx) => {
    const run = await getRun(tx, ref.runStartedAt, ref.runId)
    if (run === null) return { kind: 'gone' }

    if (isTerminalRunStatus(run.status)) {
      return { kind: 'finished', status: run.status }
    }

    if (run.cancelRequestedAt !== null) {
      // Steps already in flight are allowed to finish; nothing new starts.
      //
      // Record *where* it stopped. "Cancelled" alone tells whoever asks
      // nothing useful — they need to know which steps ran and which never
      // will, and reconstructing that later means guessing from timestamps.
      const stoppedAt = await nextRunnableStep(tx, run)
      await setRunStatus(tx, run, 'cancelled', {
        ...(stoppedAt === null ? {} : { cancelledAtStepId: stoppedAt.nodeId }),
      })
      return { kind: 'finished', status: 'cancelled' }
    }

    if (run.deadlineAt !== null && run.deadlineAt.getTime() <= Date.now()) {
      await setRunStatus(tx, run, 'timed_out', { errorClass: 'timeout' })
      return { kind: 'finished', status: 'timed_out' }
    }

    const step = await nextRunnableStep(tx, run)
    if (step === null) {
      return finishOrWait(tx, run)
    }

    if (run.status === 'queued') {
      await setRunStatus(tx, run, 'running')
    }

    await enqueue(tx, {
      topic: 'run_step',
      payload: {
        runId: run.id,
        runStartedAt: run.startedAt.toISOString(),
        stepId: step.id,
        tenantId: run.tenantId,
      },
      tenantId: run.tenantId,
    })

    return { kind: 'dispatched', stepId: step.id, nodeId: step.nodeId }
  })
}

/**
 * No step is runnable. That means one of three things, and telling them apart
 * is the difference between a finished run and a stuck one.
 */
async function finishOrWait(
  tx: Parameters<typeof listSteps>[0],
  run: RunRow,
): Promise<AdvanceOutcome> {
  const steps = await listSteps(tx, run)

  const terminallyFailed = steps.find(
    (step) =>
      (step.status === 'failed' && step.nextAttemptAt === null) ||
      step.status === 'timed_out',
  )
  if (terminallyFailed !== undefined) {
    await setRunStatus(tx, run, 'failed', {
      errorClass: terminallyFailed.errorClass ?? 'internal',
      errorCode: terminallyFailed.errorCode ?? undefined,
      errorStepId: terminallyFailed.nodeId,
    })
    return { kind: 'finished', status: 'failed' }
  }

  const paused = steps.find((step) => step.status === 'waiting_confirmation')
  if (paused !== undefined) {
    // The honest at-most-once path: we do not know whether the effect
    // happened, so a human decides rather than the engine guessing.
    await setRunStatus(tx, run, 'waiting_confirmation', {
      errorClass: paused.errorClass ?? 'unknown_outcome',
      errorStepId: paused.nodeId,
    })
    return { kind: 'waiting', reason: 'awaiting confirmation' }
  }

  const unfinished = steps.filter(
    (step) => !['succeeded', 'skipped', 'skipped_resumed', 'cancelled'].includes(step.status),
  )
  if (unfinished.length === 0) {
    await setRunStatus(tx, run, 'succeeded')
    return { kind: 'finished', status: 'succeeded' }
  }

  // Something is scheduled but not yet due — a retry waiting out its backoff,
  // or a step another worker holds a live lease on. Not stuck, just early.
  return { kind: 'waiting', reason: `${unfinished.length} step(s) not yet due` }
}
