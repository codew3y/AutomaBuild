/**
 * Schema tests. These need the docker-compose stack:
 *
 *   npm run db:up && npm run db:migrate && npm test
 *
 * They assert the properties that are easy to get wrong and impossible to
 * notice: that partitions exist and are daily, that no default partition was
 * created, that the unique key really does reject a duplicate step, and that
 * the lease guard makes a second claim a no-op.
 *
 * Skipped rather than failed when no database is reachable, so the pure-core
 * suite stays runnable with nothing installed.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { dbConfigFromEnv } from '../src/db/config.ts'

const config = dbConfigFromEnv()

async function canConnect(): Promise<boolean> {
  const probe = new Client({ ...config, connectionTimeoutMillis: 2000 })
  try {
    await probe.connect()
    await probe.end()
    return true
  } catch {
    return false
  }
}

const DB_UP = await canConnect()
const SKIP = DB_UP ? false : 'no database — run `npm run db:up && npm run db:migrate`'

describe('schema', { skip: SKIP }, () => {
  let db: Client

  before(async () => {
    db = new Client(config)
    await db.connect()
  })

  after(async () => {
    await db.end()
  })

  const tenant = randomUUID()

  async function insertRun(startedAt = 'now()'): Promise<{ id: string; startedAt: Date }> {
    const { rows } = await db.query<{ id: string; started_at: Date }>(
      `INSERT INTO runs (tenant_id, flow_id, flow_version_id, status, started_at)
       VALUES ($1, $2, $3, 'queued', ${startedAt})
       RETURNING id, started_at`,
      [tenant, randomUUID(), randomUUID()],
    )
    return { id: rows[0]!.id, startedAt: rows[0]!.started_at }
  }

  it('partitions both tables by day', async () => {
    const { rows } = await db.query<{ parent: string; partitions: string }>(
      `SELECT parent.relname AS parent, count(*)::text AS partitions
         FROM pg_inherits
         JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
        WHERE parent.relname IN ('runs','step_executions')
        GROUP BY parent.relname
        ORDER BY parent.relname`,
    )
    assert.equal(rows.length, 2, 'both tables should have partitions')
    for (const row of rows) {
      assert.ok(Number(row.partitions) >= 7, `${row.parent} has only ${row.partitions} partitions`)
    }
  })

  it('has no default partition, so partitions can be detached concurrently', async () => {
    // pg_partman defaults p_default_table to true. A default partition makes
    // DETACH CONCURRENTLY illegal, which quietly removes the entire benefit of
    // partitioning daily — and only shows up months later, under load.
    const { rows } = await db.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname IN ('runs','step_executions')
          AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    )
    assert.deepEqual(rows, [], 'a default partition exists — DETACH CONCURRENTLY will be refused')
  })

  it('rejects a row outside every partition rather than filing it away', async () => {
    // The cost of having no default partition, and the correct trade: a run
    // with a nonsensical timestamp fails loudly at insert.
    await assert.rejects(
      () => insertRun(`'1999-01-01'::timestamptz`),
      (error: Error) => {
        assert.match(error.message, /no partition of relation/)
        return true
      },
    )
  })

  it('uses a composite primary key that includes the partition key', async () => {
    // A unique or primary key on a partitioned table must contain every
    // partition key column, so PRIMARY KEY (id) is simply unavailable here.
    const { rows } = await db.query<{ table: string; columns: string[] }>(
      // attname is `name`, not text, and node-pg has no parser for name[] —
      // it would arrive as the raw string "{started_at,id}". Cast so the
      // driver returns an actual array.
      `SELECT c.relname AS table,
              array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE con.contype = 'p' AND c.relname IN ('runs','step_executions')
        GROUP BY c.relname ORDER BY c.relname`,
    )
    const byTable = new Map(rows.map((r) => [r.table, r.columns]))
    assert.deepEqual(byTable.get('runs'), ['started_at', 'id'])
    assert.deepEqual(byTable.get('step_executions'), ['run_started_at', 'id'])
  })

  it('stores partition keys at millisecond precision', async () => {
    // Regression, and a subtle one. A JavaScript Date holds milliseconds; a
    // plain timestamptz holds microseconds. At full precision, now() stores
    // .319437, the driver hands back .319, and every subsequent lookup by
    // (started_at, id) silently misses — while the same truncated value gets
    // denormalised into step_executions.run_started_at, so the two tables end
    // up disagreeing about the partition key that is supposed to join them.
    const { rows } = await db.query<{ scale: number; table: string; column: string }>(
      `SELECT c.relname AS table, a.attname AS column,
              information_schema._pg_datetime_precision(a.atttypid, a.atttypmod) AS scale
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE (c.relname, a.attname) IN
              (('runs','started_at'), ('step_executions','run_started_at'),
               ('run_idempotency','run_started_at'))
          AND a.attnum > 0`,
    )
    assert.ok(rows.length >= 3, 'expected all three partition-key columns')
    for (const row of rows) {
      assert.equal(row.scale, 3, `${row.table}.${row.column} is not millisecond precision`)
    }
  })

  it('round-trips a partition key through a JavaScript Date without loss', async () => {
    const run = await insertRun()
    const { rowCount } = await db.query(
      'SELECT 1 FROM runs WHERE started_at = $1 AND id = $2',
      [run.startedAt, run.id],
    )
    assert.equal(rowCount, 1, 'a run could not be found by the timestamp it just returned')
  })

  it('keeps runs and step_executions agreeing on the partition key', async () => {
    const run = await insertRun()
    await db.query(
      `INSERT INTO step_executions
         (tenant_id, run_id, run_started_at, node_id, topo_order, step_kind, status, idempotency_key)
       VALUES ($1, $2, $3, 'node-join', 0, 'noop', 'pending', 'key-join')`,
      [tenant, run.id, run.startedAt],
    )
    const { rowCount } = await db.query(
      `SELECT 1 FROM runs r
         JOIN step_executions s
           ON s.run_id = r.id AND s.run_started_at = r.started_at
        WHERE r.id = $1 AND r.started_at = $2`,
      [run.id, run.startedAt],
    )
    assert.equal(rowCount, 1, 'the partition-local join found nothing — the timestamps disagree')
  })

  it('generates time-ordered ids, so inserts land at the index edge', async () => {
    const first = await insertRun()
    const second = await insertRun()
    assert.ok(first.id < second.id, 'uuidv7 should be monotonic within a session')
  })

  it('makes a duplicate step a constraint violation, not a second execution', async () => {
    const run = await insertRun()
    const insertStep = () =>
      db.query(
        `INSERT INTO step_executions
           (tenant_id, run_id, run_started_at, node_id, topo_order, step_kind, status, idempotency_key)
         VALUES ($1, $2, $3, 'node-a', 0, 'http', 'pending', 'key-1')`,
        [tenant, run.id, run.startedAt],
      )

    await insertStep()
    await assert.rejects(insertStep, (error: Error) => {
      assert.match(error.message, /step_exec_identity|duplicate key/)
      return true
    })
  })

  it('deduplicates a repeated trigger delivery', async () => {
    // Regression, and the reason run_idempotency exists as its own table.
    // A partial unique index on runs cannot do this: it would have to include
    // started_at, which is the partition key and differs on every insert, so
    // it would reject only rows landing in the same microsecond while looking
    // for all the world like a uniqueness guarantee.
    const flow = randomUUID()
    const claimKey = async () => {
      const run = await insertRun()
      await db.query(
        `INSERT INTO run_idempotency (tenant_id, flow_id, idempotency_key, run_id, run_started_at)
         VALUES ($1, $2, 'trigger-1', $3, $4)`,
        [tenant, flow, run.id, run.startedAt],
      )
      return run
    }

    const first = await claimKey()
    await assert.rejects(claimKey, /duplicate key/)

    // And the original run is still reachable, so the caller can return it
    // rather than creating a second one.
    const { rows } = await db.query<{ run_id: string }>(
      `SELECT run_id FROM run_idempotency
        WHERE tenant_id = $1 AND flow_id = $2 AND idempotency_key = 'trigger-1'`,
      [tenant, flow],
    )
    assert.equal(rows[0]?.run_id, first.id)
  })

  it('the vacuous index on runs is gone', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'runs_idempotency'`,
    )
    assert.equal(rows.length, 0, 'an index that promises uniqueness it cannot deliver is worse than none')
  })

  it('refuses a status the state machine does not define', async () => {
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO runs (tenant_id, flow_id, flow_version_id, status)
           VALUES ($1, $2, $3, 'nonsense')`,
          [tenant, randomUUID(), randomUUID()],
        ),
      /violates check constraint/,
    )
  })

  it('claims a lease exactly once under a duplicate delivery', async () => {
    // The guard that makes at-least-once delivery survivable. Two workers
    // receive the same message; the conditional update means one wins and the
    // other gets zero rows and exits.
    const run = await insertRun()
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO step_executions
         (tenant_id, run_id, run_started_at, node_id, topo_order, step_kind, status, idempotency_key)
       VALUES ($1, $2, $3, 'node-lease', 0, 'http', 'pending', 'key-lease')
       RETURNING id`,
      [tenant, run.id, run.startedAt],
    )
    const stepId = rows[0]!.id

    const claim = (worker: string) =>
      db.query(
        `UPDATE step_executions
            SET status = 'running',
                worker_id = $1,
                lease_expires_at = now() + interval '60 seconds',
                attempts_started = attempts_started + 1
          WHERE run_started_at = $2 AND id = $3
            AND status = 'pending'
          RETURNING id`,
        [worker, run.startedAt, stepId],
      )

    const first = await claim('worker-1')
    const second = await claim('worker-2')

    assert.equal(first.rowCount, 1, 'the first claim should win')
    assert.equal(second.rowCount, 0, 'the second claim must be a no-op')

    const { rows: after } = await db.query<{ worker_id: string; attempts_started: number }>(
      `SELECT worker_id, attempts_started FROM step_executions WHERE run_started_at = $1 AND id = $2`,
      [run.startedAt, stepId],
    )
    assert.equal(after[0]?.worker_id, 'worker-1')
    assert.equal(after[0]?.attempts_started, 1, 'the losing claim must not have counted an attempt')
  })

  it('schedules partition maintenance rather than hoping', async () => {
    // Partition maintenance failing silently is the specific risk: nothing
    // breaks until the premake window runs out, and then every insert fails at
    // once because there is no default partition to catch them.
    const { rows } = await db.query<{ jobname: string; schedule: string }>(
      `SELECT jobname, schedule FROM cron.job WHERE jobname = 'partman-maintenance'`,
    )
    assert.equal(rows.length, 1, 'the partman maintenance job is not scheduled')
  })

  it('keeps retention as detach, so a wrong setting is recoverable', async () => {
    const { rows } = await db.query<{ parent_table: string; retention_keep_table: boolean }>(
      `SELECT parent_table, retention_keep_table FROM partman.part_config ORDER BY parent_table`,
    )
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.retention_keep_table, true, `${row.parent_table} would drop data outright`)
    }
  })
})
