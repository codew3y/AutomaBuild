/**
 * The synchronous queue driver.
 *
 * A real worker loop is the wrong tool for testing retry behaviour: a
 * five-attempt ladder spans half an hour of wall-clock time, and asserting on
 * it means either waiting or sleeping and hoping. This drains the outbox
 * deterministically instead — process every due message, then stop — so a
 * whole run, retries included, is one synchronous test with no timers.
 *
 * `advanceClockBy` is how time passes. Rather than faking a clock (which the
 * database would not share), it shifts scheduled rows *backwards*, which has
 * the same effect from every query's point of view and keeps Postgres as the
 * single clock. A thirty-day delay tests in a millisecond.
 *
 * This is also the production dispatch loop, minus the polling. Same code
 * path, so the tests exercise what actually runs.
 */

import type { Pool } from 'pg'
import { withTransaction } from '../db/client.ts'
import { claimOutboxBatch, deleteOutbox } from './repository.ts'
import { advanceRun } from './orchestrator.ts'
import { runStep, type ExecutorDeps, type StepOutcome } from './executor.ts'
import type { AdvanceOutcome } from './orchestrator.ts'

export interface DrainOptions {
  /** Hard ceiling on messages processed, so a loop cannot run away in a test. */
  readonly maxJobs?: number
  /**
   * Process only this tenant's work.
   *
   * In production this is how a worker pool is dedicated to a tenant. In tests
   * it is what stops one test draining another's queue — the outbox is global,
   * so an unscoped drain will happily execute somebody else's run against the
   * wrong flow definition and the wrong handlers.
   */
  readonly tenantId?: string
  /** Shift every scheduled row this far into the past before draining. */
  readonly advanceClockBy?: number
  readonly batchSize?: number
}

export interface DrainReport {
  readonly processed: number
  readonly advances: AdvanceOutcome[]
  readonly steps: StepOutcome[]
}

/**
 * Move scheduled work into the past.
 *
 * Retries and delayed messages are stored as absolute instants computed by
 * Postgres. Subtracting from them is indistinguishable, to every query that
 * matters, from time having passed — and it needs no fake clock inside the
 * database, which is not something we could install anyway.
 */
export async function advanceClock(pool: Pool, ms: number, tenantId?: string): Promise<void> {
  if (ms <= 0) return
  const scope = tenantId ?? null
  await withTransaction(pool, async (tx) => {
    await tx.query(
      `UPDATE outbox SET available_at = available_at - ($1::bigint * interval '1 millisecond')
        WHERE ($2::uuid IS NULL OR tenant_id = $2)`,
      [ms, scope],
    )
    await tx.query(
      `UPDATE step_executions
          SET next_attempt_at = next_attempt_at - ($1::bigint * interval '1 millisecond')
        WHERE next_attempt_at IS NOT NULL AND ($2::uuid IS NULL OR tenant_id = $2)`,
      [ms, scope],
    )
    await tx.query(
      `UPDATE step_executions
          SET lease_expires_at = lease_expires_at - ($1::bigint * interval '1 millisecond')
        WHERE lease_expires_at IS NOT NULL AND ($2::uuid IS NULL OR tenant_id = $2)`,
      [ms, scope],
    )
    await tx.query(
      `UPDATE runs
          SET deadline_at = deadline_at - ($1::bigint * interval '1 millisecond')
        WHERE deadline_at IS NOT NULL AND finished_at IS NULL
          AND ($2::uuid IS NULL OR tenant_id = $2)`,
      [ms, scope],
    )
  })
}

export async function drainQueue(
  pool: Pool,
  deps: ExecutorDeps,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const maxJobs = options.maxJobs ?? 100
  const batchSize = options.batchSize ?? 10

  if (options.advanceClockBy !== undefined) {
    await advanceClock(pool, options.advanceClockBy, options.tenantId)
  }

  const advances: AdvanceOutcome[] = []
  const steps: StepOutcome[] = []
  let processed = 0

  while (processed < maxJobs) {
    // Claim and delete in one transaction, then act. A message that is
    // dispatched but whose deletion is rolled back would be delivered again —
    // which is survivable, because that is what the lease guard is for, but it
    // is not something to do on purpose.
    const batch = await withTransaction(pool, async (tx) => {
      const claimed = await claimOutboxBatch(
        tx,
        Math.min(batchSize, maxJobs - processed),
        options.tenantId,
      )
      await deleteOutbox(
        tx,
        claimed.map((message) => message.id),
      )
      return claimed
    })

    if (batch.length === 0) break

    for (const message of batch) {
      processed++
      const runId = message.payload.runId as string
      const runStartedAt = new Date(message.payload.runStartedAt as string)

      if (message.topic === 'advance_run') {
        advances.push(await advanceRun(pool, { runId, runStartedAt }))
        continue
      }

      steps.push(
        await runStep(
          pool,
          { runId, runStartedAt, stepId: message.payload.stepId as string },
          deps,
        ),
      )
    }
  }

  return { processed, advances, steps }
}

/**
 * Drain repeatedly, advancing time between passes, until the queue stays empty.
 *
 * How a test says "let this run to completion, however many retries that
 * takes" without knowing the ladder in advance.
 */
export async function drainUntilQuiet(
  pool: Pool,
  deps: ExecutorDeps,
  options: {
    maxRounds?: number
    advanceEach?: number
    maxJobs?: number
    tenantId?: string
  } = {},
): Promise<DrainReport> {
  const maxRounds = options.maxRounds ?? 30
  const advanceEach = options.advanceEach ?? 60_000

  const advances: AdvanceOutcome[] = []
  const steps: StepOutcome[] = []
  let processed = 0

  for (let round = 0; round < maxRounds; round++) {
    const report = await drainQueue(pool, deps, {
      ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
      ...(round === 0 ? {} : { advanceClockBy: advanceEach }),
    })
    processed += report.processed
    advances.push(...report.advances)
    steps.push(...report.steps)

    if (report.processed === 0) {
      // Nothing was due even after moving time forward: the run is finished or
      // genuinely waiting on something outside the engine.
      if (round > 0) break
    }
  }

  return { processed, advances, steps }
}
