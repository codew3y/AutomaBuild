/**
 * The janitor: the reason a killed worker is a delay rather than a loss.
 *
 * Everything else in the engine is driven by a message. That works right up
 * until the message is gone — a worker claimed a step and died, or Redis was
 * flushed, or a process was killed between doing the work and recording it. In
 * all of those cases the database still knows the truth, and nothing is
 * scheduled to act on it.
 *
 * This sweep is what closes that gap. It is deliberately dumb: it finds rows
 * that are demonstrably stuck and re-schedules them. It never executes
 * anything itself, so it cannot become a second, subtly different executor.
 *
 * The invariant it upholds: flush the queue entirely, and every non-terminal
 * run still finishes.
 */

import type { Pool } from 'pg'
import { withTransaction } from '../db/client.ts'
import { enqueue } from './repository.ts'

export interface SweepReport {
  /** Steps whose owner died and whose lease has lapsed. */
  readonly expiredLeases: number
  /** Runs past their wall-clock deadline that have not stopped. */
  readonly overdueRuns: number
  /** Non-terminal runs with nothing scheduled to move them. */
  readonly strandedRuns: number
}

export interface SweepOptions {
  readonly tenantId?: string
  readonly limit?: number
}

/**
 * One pass. Safe to run concurrently with itself and with workers: everything
 * it does is idempotent, and a duplicate `advance_run` is a no-op by design.
 */
export async function sweep(pool: Pool, options: SweepOptions = {}): Promise<SweepReport> {
  const tenant = options.tenantId ?? null
  const limit = options.limit ?? 100

  return withTransaction(pool, async (tx) => {
    // 1. Leases that have lapsed. The step is still `running` and nobody is
    //    running it. Re-scheduling the run makes it claimable again; the lease
    //    guard decides who gets it.
    const expired = await tx.query<{ run_id: string; run_started_at: Date; tenant_id: string }>(
      `SELECT DISTINCT run_id, run_started_at, tenant_id
         FROM step_executions
        WHERE status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()
          AND ($1::uuid IS NULL OR tenant_id = $1)
        LIMIT $2`,
      [tenant, limit],
    )

    // 2. Runs that have outlived their budget. The orchestrator will mark them
    //    timed out; it needs to be asked.
    const overdue = await tx.query<{ id: string; started_at: Date; tenant_id: string }>(
      `SELECT id, started_at, tenant_id
         FROM runs
        WHERE status IN ('queued','running')
          AND deadline_at IS NOT NULL
          AND deadline_at < now()
          AND ($1::uuid IS NULL OR tenant_id = $1)
        LIMIT $2`,
      [tenant, limit],
    )

    // 3. Runs with work still to do and nothing scheduled to do it.
    //
    //    This is the "Redis was flushed" case, and the reason the queue can be
    //    treated as disposable: the outbox row is gone, no lease is held, and
    //    without this the run would sit at `running` forever looking healthy.
    const stranded = await tx.query<{ id: string; started_at: Date; tenant_id: string }>(
      `SELECT r.id, r.started_at, r.tenant_id
         FROM runs r
        WHERE r.status IN ('queued','running')
          AND ($1::uuid IS NULL OR r.tenant_id = $1)
          AND NOT EXISTS (
                SELECT 1 FROM outbox o
                 WHERE o.payload->>'runId' = r.id::text
              )
          AND NOT EXISTS (
                SELECT 1 FROM step_executions s
                 WHERE s.run_started_at = r.started_at
                   AND s.run_id = r.id
                   AND s.status = 'running'
                   AND s.lease_expires_at IS NOT NULL
                   AND s.lease_expires_at >= now()
              )
        LIMIT $2`,
      [tenant, limit],
    )

    const scheduled = new Set<string>()
    const schedule = async (runId: string, startedAt: Date, tenantId: string) => {
      if (scheduled.has(runId)) return
      scheduled.add(runId)
      await enqueue(tx, {
        topic: 'advance_run',
        payload: { runId, runStartedAt: startedAt.toISOString() },
        tenantId,
      })
    }

    for (const row of expired.rows) {
      await schedule(row.run_id, row.run_started_at, row.tenant_id)
    }
    for (const row of overdue.rows) {
      await schedule(row.id, row.started_at, row.tenant_id)
    }
    for (const row of stranded.rows) {
      await schedule(row.id, row.started_at, row.tenant_id)
    }

    return {
      expiredLeases: expired.rowCount ?? 0,
      overdueRuns: overdue.rowCount ?? 0,
      strandedRuns: stranded.rowCount ?? 0,
    }
  })
}

/**
 * How many days of partitions exist ahead of today, per partitioned table.
 *
 * This metric has to exist before it is needed, not after. Partition
 * maintenance failing is completely silent: everything works normally right up
 * to the moment the premake window runs out, and then every insert fails at
 * once, because there is deliberately no default partition to catch them.
 * Nothing degrades first, and nothing appears in any log.
 *
 * Counted as days ahead of today rather than total partitions, because the
 * total keeps rising as history accumulates — it would look healthy while the
 * future ran out.
 */
export interface PartitionHealth {
  readonly table: string
  readonly daysAhead: number
  readonly healthy: boolean
}

/** Below this much headroom, somebody should be told. */
export const PARTITION_HEADROOM_WARNING_DAYS = 3

export async function partitionHealth(
  pool: Pool,
  tables: readonly string[] = ['runs', 'step_executions'],
): Promise<PartitionHealth[]> {
  // Read the date from the partition *name* rather than parsing the bound
  // expression. pg_partman names daily partitions `<parent>_pYYYYMMDD`, and
  // that is far easier to get right than a regex over
  // `FOR VALUES FROM ('...') TO ('...')` — which has to survive being escaped
  // through a SQL string literal on its way to the regex engine, and which
  // silently returns NULL rather than erroring when it does not.
  const { rows } = await pool.query<{ parent: string; days_ahead: string }>(
    `WITH partitions AS (
       SELECT p.relname AS parent,
              substring(c.relname from '_p([0-9]{8})$') AS day_suffix
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = ANY($1::text[])
     )
     SELECT parent,
            count(*) FILTER (
              WHERE day_suffix IS NOT NULL
                AND to_date(day_suffix, 'YYYYMMDD') >= current_date
            )::text AS days_ahead
       FROM partitions
      GROUP BY parent`,
    [tables],
  )

  const byTable = new Map(rows.map((row) => [row.parent, Number(row.days_ahead)]))
  return tables.map((table) => {
    const daysAhead = byTable.get(table) ?? 0
    return { table, daysAhead, healthy: daysAhead >= PARTITION_HEADROOM_WARNING_DAYS }
  })
}

/**
 * Throw if any partitioned table is running out of future partitions.
 *
 * For a readiness probe or a scheduled check. Failing loudly here costs far
 * less than discovering it when writes start rejecting.
 */
export async function assertPartitionHeadroom(
  pool: Pool,
  tables?: readonly string[],
): Promise<PartitionHealth[]> {
  const health = await partitionHealth(pool, tables)
  const starved = health.filter((entry) => !entry.healthy)
  if (starved.length > 0) {
    throw new Error(
      `Partition headroom exhausted: ${starved
        .map((entry) => `${entry.table} has ${entry.daysAhead} day(s) ahead`)
        .join('; ')}. pg_partman maintenance is probably not running, and once ` +
        `the window closes every insert fails at once — there is no default partition.`,
    )
  }
  return health
}
