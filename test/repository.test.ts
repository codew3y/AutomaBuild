/**
 * The data layer, and specifically the lease guard.
 *
 * These use real concurrent connections rather than sequential calls, because
 * the property under test is what happens when two workers race. A test that
 * claims twice in a row on one connection proves almost nothing: the
 * interesting case is two transactions in flight at the same moment.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool, withTransaction } from '../src/db/client.ts'
import { dbConfigFromEnv } from '../src/db/config.ts'
import {
  claimOutboxBatch,
  claimStep,
  createRun,
  deleteOutbox,
  enqueue,
  listSteps,
  nextRunnableStep,
  recordFailure,
  recordSuccess,
  renewLease,
  requestCancel,
  setRunStatus,
} from '../src/engine/repository.ts'
import type { FlowDefinition } from '../src/types.ts'

async function databaseReachable(): Promise<boolean> {
  const probe = createPool({ ...dbConfigFromEnv() })
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => {})
  }
}

const SKIP = (await databaseReachable())
  ? false
  : 'no database — run `npm run db:up && npm run db:migrate`'

const flow = (nodes = 3): FlowDefinition => ({
  id: randomUUID(),
  versionId: randomUUID(),
  nodes: Array.from({ length: nodes }, (_, i) => ({
    id: `node-${i}`,
    kind: 'noop',
    idempotent: true,
  })),
})

describe('repository', { skip: SKIP }, () => {
  let pool: Pool
  const tenantId = randomUUID()

  before(() => {
    pool = createPool()
  })

  after(async () => {
    await pool.end()
  })

  const newRun = async (definition = flow()) =>
    withTransaction(pool, async (tx) => {
      const { run } = await createRun(tx, { tenantId, flow: definition })
      return run
    })

  describe('creating a run', () => {
    it('materialises every step and schedules the run in one transaction', async () => {
      const definition = flow(3)
      const run = await newRun(definition)

      const steps = await listSteps(pool, run)
      assert.equal(steps.length, 3)
      assert.deepEqual(
        steps.map((s) => s.topoOrder),
        [0, 1, 2],
      )
      assert.ok(steps.every((s) => s.status === 'pending'))

      // Queried directly rather than through claimOutboxBatch: that takes the
      // oldest N rows across every tenant, so undrained rows from other tests
      // can push this one out of the window and make the assertion flaky.
      const { rowCount } = await pool.query(
        `SELECT 1 FROM outbox
          WHERE topic = 'advance_run' AND payload->>'runId' = $1`,
        [run.id],
      )
      assert.equal(rowCount, 1, 'creating a run must schedule it in the same transaction')
    })

    it('gives every step a distinct, stable idempotency key', async () => {
      const run = await newRun()
      const steps = await listSteps(pool, run)
      const keys = new Set(steps.map((s) => s.idempotencyKey))
      assert.equal(keys.size, steps.length, 'two steps share an idempotency key')
      assert.ok(steps.every((s) => s.idempotencyKey.length === 64))
    })

    it('returns the original run when a trigger is delivered twice', async () => {
      const definition = flow(1)
      const create = () =>
        withTransaction(pool, (tx) =>
          createRun(tx, { tenantId, flow: definition, idempotencyKey: 'delivery-1' }),
        )

      const first = await create()
      const second = await create()

      assert.equal(first.deduplicated, false)
      assert.equal(second.deduplicated, true)
      assert.equal(second.run.id, first.run.id, 'a duplicate delivery created a second run')
    })

    it('survives two duplicate deliveries arriving at the same moment', async () => {
      // The race the dedup table exists for. One of these must lose the
      // primary key and return the winner's run rather than erroring out.
      const definition = flow(1)
      const create = () =>
        withTransaction(pool, (tx) =>
          createRun(tx, { tenantId, flow: definition, idempotencyKey: 'concurrent-1' }),
        )

      const results = await Promise.allSettled([create(), create()])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      assert.equal(fulfilled.length, 2, `both should resolve: ${JSON.stringify(results)}`)

      const runIds = new Set(
        fulfilled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>).value.run.id),
      )
      assert.equal(runIds.size, 1, 'a concurrent duplicate delivery created two runs')
    })
  })

  describe('the lease guard', () => {
    it('lets exactly one of two concurrent workers claim a step', async () => {
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)

      const claim = (workerId: string) =>
        withTransaction(pool, (tx) =>
          claimStep(tx, {
            runStartedAt: run.startedAt,
            stepId: step!.id,
            workerId,
            leaseMs: 60_000,
          }),
        )

      const [a, b] = await Promise.all([claim('worker-a'), claim('worker-b')])
      const winners = [a, b].filter((result) => result.kind === 'claimed')

      assert.equal(winners.length, 1, 'both workers claimed the same step')
      assert.equal(winners[0]?.step.attemptsStarted, 1, 'the loser must not have counted an attempt')
    })

    it('holds under ten simultaneous claims', async () => {
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)

      const claims = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          withTransaction(pool, (tx) =>
            claimStep(tx, {
              runStartedAt: run.startedAt,
              stepId: step!.id,
              workerId: `worker-${i}`,
              leaseMs: 60_000,
            }),
          ),
        ),
      )

      assert.equal(claims.filter((c) => c.kind === 'claimed').length, 1)
      const after = await listSteps(pool, run)
      assert.equal(after[0]?.attemptsStarted, 1, 'losing claims incremented the attempt counter')
    })

    it('refuses a second claim while the lease is live', async () => {
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      const claim = (workerId: string, leaseMs: number) =>
        withTransaction(pool, (tx) =>
          claimStep(tx, { runStartedAt: run.startedAt, stepId: step!.id, workerId, leaseMs }),
        )

      assert.equal((await claim('worker-a', 60_000)).kind, 'claimed')
      assert.equal((await claim('worker-b', 60_000)).kind, 'taken')
    })

    it('lets another worker take over once the lease expires', async () => {
      // The crash-recovery path: a worker dies mid-step, its lease lapses, and
      // the step becomes claimable again without anyone intervening.
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      const claim = (workerId: string, leaseMs: number) =>
        withTransaction(pool, (tx) =>
          claimStep(tx, { runStartedAt: run.startedAt, stepId: step!.id, workerId, leaseMs }),
        )

      const first = await claim('worker-a', 1)
      assert.equal(first.kind, 'claimed')
      await new Promise((resolve) => setTimeout(resolve, 40))

      const second = await claim('worker-b', 60_000)
      assert.equal(second.kind, 'claimed', 'an expired lease should be reclaimable')
      assert.equal(second.step.workerId, 'worker-b')
      assert.equal(second.step.attemptsStarted, 2, 'the retake is a second attempt')
    })

    it('only renews a lease for the worker that holds it', async () => {
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      await withTransaction(pool, (tx) =>
        claimStep(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'worker-a',
          leaseMs: 60_000,
        }),
      )

      assert.equal(
        await withTransaction(pool, (tx) =>
          renewLease(tx, {
            runStartedAt: run.startedAt,
            stepId: step!.id,
            workerId: 'worker-a',
            leaseMs: 60_000,
          }),
        ),
        true,
      )
      assert.equal(
        await withTransaction(pool, (tx) =>
          renewLease(tx, {
            runStartedAt: run.startedAt,
            stepId: step!.id,
            workerId: 'worker-b',
            leaseMs: 60_000,
          }),
        ),
        false,
        'a worker that does not hold the lease must not be able to extend it',
      )
    })
  })

  describe('recording outcomes', () => {
    it('only accepts a result from the worker holding the lease', async () => {
      // A worker whose lease expired mid-step must not be able to write a
      // result over whatever the new owner is doing.
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      await withTransaction(pool, (tx) =>
        claimStep(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'worker-a',
          leaseMs: 60_000,
        }),
      )

      const wrote = await withTransaction(pool, (tx) =>
        recordSuccess(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'worker-b',
          output: { hijacked: true },
        }),
      )
      assert.equal(wrote, false)

      const [after] = await listSteps(pool, run)
      assert.equal(after?.status, 'running')
      assert.equal(after?.outputInline, null)
    })

    it('stores counters as absolute values from the state machine', async () => {
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      await withTransaction(pool, (tx) =>
        claimStep(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'worker-a',
          leaseMs: 60_000,
        }),
      )

      await withTransaction(pool, (tx) =>
        recordFailure(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'worker-a',
          status: 'failed',
          attemptsConsumed: 0,
          deferrals: 3,
          retryDelayMs: 30_000,
          errorClass: 'rate_limited',
        }),
      )

      const [after] = await listSteps(pool, run)
      assert.equal(after?.status, 'failed')
      assert.equal(after?.attemptsConsumed, 0, 'a rate limit must not consume an attempt')
      assert.equal(after?.deferrals, 3)
      assert.equal(after?.errorClass, 'rate_limited')
      assert.ok(after?.nextAttemptAt)
    })
  })

  describe('choosing what runs next', () => {
    it('walks the chain in order', async () => {
      const run = await newRun(flow(3))
      const steps = await listSteps(pool, run)

      for (const expected of steps) {
        const next = await withTransaction(pool, (tx) => nextRunnableStep(tx, run))
        assert.equal(next?.nodeId, expected.nodeId)

        await withTransaction(pool, async (tx) => {
          await claimStep(tx, {
            runStartedAt: run.startedAt,
            stepId: expected.id,
            workerId: 'w',
            leaseMs: 60_000,
          })
          await recordSuccess(tx, {
            runStartedAt: run.startedAt,
            stepId: expected.id,
            workerId: 'w',
            output: null,
          })
        })
      }

      assert.equal(await withTransaction(pool, (tx) => nextRunnableStep(tx, run)), null)
    })

    it('does not return a step whose retry is not yet due', async () => {
      // The run is waiting, not runnable. Returning it here would busy-loop
      // the orchestrator against a step that cannot legally start.
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      await withTransaction(pool, async (tx) => {
        await claimStep(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'w',
          leaseMs: 60_000,
        })
        await recordFailure(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'w',
          status: 'failed',
          attemptsConsumed: 1,
          deferrals: 0,
          retryDelayMs: 60_000,
          errorClass: 'transient_network',
        })
      })

      assert.equal(await withTransaction(pool, (tx) => nextRunnableStep(tx, run)), null)
    })

    it('returns a step whose retry has come due', async () => {
      const run = await newRun(flow(1))
      const [step] = await listSteps(pool, run)
      await withTransaction(pool, async (tx) => {
        await claimStep(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'w',
          leaseMs: 60_000,
        })
        await recordFailure(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'w',
          status: 'failed',
          attemptsConsumed: 1,
          deferrals: 0,
          retryDelayMs: -1_000,
          errorClass: 'transient_network',
        })
      })

      const next = await withTransaction(pool, (tx) => nextRunnableStep(tx, run))
      assert.equal(next?.id, step!.id)
    })
  })

  describe('cancellation', () => {
    it('records the request and refuses once the run is terminal', async () => {
      const run = await newRun(flow(1))
      assert.equal(await withTransaction(pool, (tx) => requestCancel(tx, run)), true)

      await withTransaction(pool, (tx) => setRunStatus(tx, run, 'succeeded'))
      assert.equal(
        await withTransaction(pool, (tx) => requestCancel(tx, run)),
        false,
        'a finished run cannot be cancelled',
      )
    })
  })

  describe('the outbox', () => {
    // Claims are scoped to a fresh tenant, and the batch is claimed by tenant
    // rather than globally. Unscoped, claimOutboxBatch takes the oldest N rows
    // across every tenant, so rows left behind by other tests push the row
    // under test out of the window and the assertion fails for reasons that
    // have nothing to do with SKIP LOCKED.
    let outboxTenant: string
    beforeEach(() => {
      outboxTenant = randomUUID()
    })

    it('hands a row to only one of two concurrent relays', async () => {
      const marker = randomUUID()
      await withTransaction(pool, (tx) =>
        enqueue(tx, { topic: 'advance_run', payload: { marker }, tenantId: outboxTenant }),
      )

      const drain = () =>
        withTransaction(pool, async (tx) => {
          const batch = await claimOutboxBatch(tx, 100, outboxTenant)
          const mine = batch.filter((m) => m.payload.marker === marker)
          await deleteOutbox(tx, mine.map((m) => m.id))
          return mine.length
        })

      const [first, second] = await Promise.all([drain(), drain()])
      assert.equal(first + second, 1, 'SKIP LOCKED handed the same row to both relays')
    })

    it('ignores rows that are not yet due', async () => {
      const marker = randomUUID()
      await withTransaction(pool, (tx) =>
        enqueue(tx, {
          topic: 'run_step',
          payload: { marker },
          tenantId: outboxTenant,
          delayMs: 60_000,
        }),
      )

      const batch = await withTransaction(pool, (tx) =>
        claimOutboxBatch(tx, 500, outboxTenant),
      )
      assert.equal(
        batch.filter((m) => m.payload.marker === marker).length,
        0,
        'a future row was claimed early',
      )
    })
  })
})
