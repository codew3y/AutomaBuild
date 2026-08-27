/**
 * The worker loop: waking, sweeping, and stopping without breaking anything.
 *
 * These run real loops against a real database, so they are the only tests in
 * the suite that use wall-clock time. They stay fast by keeping the poll floor
 * short and asserting on outcomes rather than on timing.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool, withTransaction } from '../src/db/client.ts'
import { dbConfigFromEnv } from '../src/db/config.ts'
import { createRun, getRun, listSteps } from '../src/engine/repository.ts'
import { startWorker, type WorkerEvent } from '../src/engine/worker.ts'
import { noopHandler, type StepHandler } from '../src/engine/handlers.ts'
import type { ExecutorDeps } from '../src/engine/executor.ts'
import { seededRandom } from '../src/random.ts'
import { DEFAULT_TIMEOUTS } from '../src/timeouts.ts'
import type { FlowDefinition } from '../src/types.ts'

async function reachable(): Promise<boolean> {
  const probe = createPool(dbConfigFromEnv())
  try {
    await probe.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await probe.end().catch(() => {})
  }
}

const SKIP = (await reachable()) ? false : 'no database — run `npm run db:up && npm run db:migrate`'

/** Poll until `check` passes, or fail with something readable. */
async function eventually(
  check: () => Promise<boolean>,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting: ${message}`)
}

describe('worker loop', { skip: SKIP }, () => {
  let pool: Pool
  let tenantId: string

  before(() => {
    pool = createPool()
  })
  beforeEach(() => {
    tenantId = randomUUID()
  })
  after(async () => {
    await pool.end()
  })

  const makeFlow = (count: number): FlowDefinition => ({
    id: randomUUID(),
    versionId: randomUUID(),
    nodes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      kind: 'noop',
      idempotent: true,
    })),
  })

  const deps = (flow: FlowDefinition, handler: StepHandler = noopHandler): ExecutorDeps => ({
    flow,
    handlers: { noop: handler },
    workerId: `w-${randomUUID().slice(0, 8)}`,
    random: seededRandom(7),
  })

  const start = (flow: FlowDefinition) =>
    withTransaction(pool, async (tx) => {
      const { run } = await createRun(tx, { tenantId, flow })
      return run
    })

  it('picks up a run without being told, and finishes it', async () => {
    const flow = makeFlow(3)
    const worker = startWorker(pool, deps(flow), { tenantId, pollIntervalMs: 100 })
    try {
      const run = await start(flow)
      await eventually(
        async () => (await getRun(pool, run.startedAt, run.id))?.status === 'succeeded',
        'the run never completed',
      )
      const steps = await listSteps(pool, run)
      assert.ok(steps.every((s) => s.status === 'succeeded'))
    } finally {
      await worker.stop()
    }
  })

  it('is woken by NOTIFY rather than waiting out the poll interval', async () => {
    // The poll floor is set absurdly high, so finishing quickly is only
    // possible if the notification arrived.
    const flow = makeFlow(1)
    const worker = startWorker(pool, deps(flow), { tenantId, pollIntervalMs: 60_000 })
    try {
      // Let the loop reach its first wait.
      await new Promise((resolve) => setTimeout(resolve, 300))

      const began = Date.now()
      const run = await start(flow)
      await eventually(
        async () => (await getRun(pool, run.startedAt, run.id))?.status === 'succeeded',
        'the run did not complete — the worker was not woken',
      )
      assert.ok(
        Date.now() - began < 20_000,
        'took long enough that it must have been the poll, not the notification',
      )
    } finally {
      await worker.stop()
    }
  })

  it('still makes progress when notifications are missed', async () => {
    // NOTIFY is not persisted and reaches only connected sessions. Insert the
    // outbox row with the trigger disabled to simulate a notification lost
    // while the listener was reconnecting: the poll floor must cover it.
    const flow = makeFlow(1)
    const worker = startWorker(pool, deps(flow), { tenantId, pollIntervalMs: 150 })
    try {
      await pool.query('ALTER TABLE outbox DISABLE TRIGGER outbox_notify')
      let run
      try {
        run = await start(flow)
      } finally {
        await pool.query('ALTER TABLE outbox ENABLE TRIGGER outbox_notify')
      }

      await eventually(
        async () => (await getRun(pool, run.startedAt, run.id))?.status === 'succeeded',
        'a missed notification stalled the run — the poll floor is not working',
      )
    } finally {
      await worker.stop()
    }
  })

  it('lets an in-flight step finish before stopping', async () => {
    // The matrix row: graceful shutdown mid-step. Killing the process here
    // would leave a lease to expire, turning every deploy into a burst of
    // duplicate work once the leases lapse.
    let released!: () => void
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })
    let entered = false

    const slow: StepHandler = async () => {
      entered = true
      await gate
      return { output: 'finished after shutdown began' }
    }

    const flow = makeFlow(1)
    const worker = startWorker(pool, deps(flow, slow), { tenantId, pollIntervalMs: 100 })
    const run = await start(flow)

    await eventually(async () => entered, 'the step never started')

    // Ask the worker to stop while the step is still running.
    const stopping = worker.stop('test')
    await new Promise((resolve) => setTimeout(resolve, 150))

    const midShutdown = await listSteps(pool, run)
    assert.equal(midShutdown[0]?.status, 'running', 'the step should still be in flight')

    released()
    await stopping

    const steps = await listSteps(pool, run)
    assert.equal(steps[0]?.status, 'succeeded', 'the in-flight step was abandoned')
    assert.equal(steps[0]?.leaseExpiresAt, null, 'the lease was not released')
  })

  it('recovers a run stranded by a lost queue, without being asked', async () => {
    const flow = makeFlow(3)
    const worker = startWorker(pool, deps(flow), {
      tenantId,
      pollIntervalMs: 100,
      sweepIntervalMs: 100,
    })
    try {
      const run = await start(flow)
      await eventually(
        async () => ((await getRun(pool, run.startedAt, run.id))?.stepsSucceeded ?? 0) >= 1,
        'the run never started',
      )

      // Wipe the queue mid-run. The worker's own sweep must notice.
      await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenantId])

      await eventually(
        async () => (await getRun(pool, run.startedAt, run.id))?.status === 'succeeded',
        'the janitor sweep did not recover the run',
      )
    } finally {
      await worker.stop()
    }
  })

  it('two workers on the same queue never double-execute a step', async () => {
    const invocations = new Map<string, number>()
    const counting: StepHandler = async (ctx) => {
      invocations.set(ctx.node.id, (invocations.get(ctx.node.id) ?? 0) + 1)
      return { output: null }
    }

    const flow = makeFlow(5)
    const a = startWorker(pool, deps(flow, counting), { tenantId, pollIntervalMs: 50 })
    const b = startWorker(pool, deps(flow, counting), { tenantId, pollIntervalMs: 50 })
    try {
      const run = await start(flow)
      await eventually(
        async () => (await getRun(pool, run.startedAt, run.id))?.status === 'succeeded',
        'the run never completed with two workers',
      )

      for (const [nodeId, count] of invocations) {
        assert.equal(count, 1, `${nodeId} executed ${count} times`)
      }
      assert.equal(invocations.size, 5)
    } finally {
      await Promise.all([a.stop(), b.stop()])
    }
  })

  it('refuses to start with inverted timeouts', async () => {
    // A drain shorter than a step attempt guarantees that every deploy
    // interrupts work that was about to succeed.
    assert.throws(
      () =>
        startWorker(pool, deps(makeFlow(1)), {
          tenantId,
          timeouts: { ...DEFAULT_TIMEOUTS, stepAttemptMs: 120_000, drainMs: 90_000 },
        }),
      /drainMs/,
    )
  })

  it('reports what it is doing', async () => {
    const events: WorkerEvent[] = []
    const flow = makeFlow(1)
    const worker = startWorker(pool, deps(flow), {
      tenantId,
      pollIntervalMs: 100,
      onEvent: (event) => events.push(event),
    })
    try {
      const run = await start(flow)
      await eventually(
        async () => (await getRun(pool, run.startedAt, run.id))?.status === 'succeeded',
        'the run never completed',
      )
    } finally {
      await worker.stop()
    }

    const types = events.map((e) => e.type)
    assert.ok(types.includes('started'))
    assert.ok(types.includes('drained'))
    assert.ok(types.includes('stopping'))
    assert.ok(types.includes('stopped'))
  })
})
