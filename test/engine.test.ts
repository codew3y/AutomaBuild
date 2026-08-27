/**
 * The engine, end to end.
 *
 * Every test here drives a real database through the same code the worker loop
 * runs, but drains the queue synchronously and moves time by shifting rows
 * rather than sleeping. A five-attempt ladder spanning half an hour is one
 * deterministic test that finishes in milliseconds.
 *
 * These are the first rows of the integration matrix.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool, withTransaction } from '../src/db/client.ts'
import { dbConfigFromEnv } from '../src/db/config.ts'
import {
  createRun,
  getRun,
  listDlqEntries,
  listSteps,
  requestCancel,
} from '../src/engine/repository.ts'
import { drainQueue, drainUntilQuiet, advanceClock } from '../src/engine/drain.ts'
import { sweep } from '../src/engine/janitor.ts'
import { noopHandler, scriptedHandler, type StepContext } from '../src/engine/handlers.ts'
import type { ExecutorDeps } from '../src/engine/executor.ts'
import { seededRandom } from '../src/random.ts'
import type { FailureFacts } from '../src/classify.ts'
import type { FlowDefinition, FlowNode } from '../src/types.ts'

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

describe('engine', { skip: SKIP }, () => {
  let pool: Pool

  // A fresh tenant per test. The outbox is global, so an unscoped drain would
  // execute another test's messages against this test's flow and handlers.
  let tenantId: string
  beforeEach(() => {
    tenantId = randomUUID()
  })

  before(() => {
    pool = createPool()
  })
  after(async () => {
    await pool.end()
  })

  const makeFlow = (nodes: FlowNode[]): FlowDefinition => ({
    id: randomUUID(),
    versionId: randomUUID(),
    nodes,
  })

  const start = async (flow: FlowDefinition, options: { runTimeoutMs?: number } = {}) =>
    withTransaction(pool, async (tx) => {
      const { run } = await createRun(tx, { tenantId, flow, ...options })
      return run
    })

  const deps = (flow: FlowDefinition, handlers: ExecutorDeps['handlers']): ExecutorDeps => ({
    flow,
    handlers,
    workerId: `worker-${randomUUID().slice(0, 8)}`,
    random: seededRandom(1234),
  })

  describe('the happy path', () => {
    it('runs a three-step chain to completion, in order', async () => {
      const order: string[] = []
      const flow = makeFlow(
        ['a', 'b', 'c'].map((id) => ({ id, kind: 'noop', idempotent: true })),
      )
      const handler = scriptedHandler({
        failures: [],
        output: 'ok',
        onInvoke: (ctx: StepContext) => order.push(ctx.node.id),
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'succeeded')
      assert.deepEqual(order, ['a', 'b', 'c'], 'steps ran out of order')
      assert.equal(finished?.stepsSucceeded, 3)

      const steps = await listSteps(pool, run)
      assert.ok(steps.every((s) => s.status === 'succeeded'))
    })

    it('makes upstream outputs visible to later steps', async () => {
      let seen: Record<string, unknown> = {}
      const flow = makeFlow([
        { id: 'first', kind: 'noop', idempotent: true, config: { output: 42 } },
        { id: 'second', kind: 'noop', idempotent: true },
      ])
      const handler = scriptedHandler({
        failures: [],
        onInvoke: (ctx) => {
          if (ctx.node.id === 'second') seen = { ...ctx.upstream }
        },
      })
      // The noop handler returns config.output, so `first` produces 42.
      const registry = {
        noop: async (ctx: StepContext) => {
          handler(ctx)
          return { output: ctx.node.config?.output ?? null }
        },
      }

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, registry), { tenantId })

      assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'succeeded')
      assert.equal(seen.first, 42, 'the second step could not see the first step output')
    })
  })

  describe('retries', () => {
    it('retries a transient failure and eventually succeeds', async () => {
      const transient: FailureFacts = { code: 'ECONNRESET' }
      let invocations = 0
      const flow = makeFlow([{ id: 'flaky', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({
        failures: [transient, transient, undefined],
        output: 'recovered',
        onInvoke: () => invocations++,
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'succeeded')
      assert.equal(invocations, 3, 'expected two failures then a success')

      const [step] = await listSteps(pool, run)
      assert.equal(step?.attemptsStarted, 3)
      assert.equal(step?.attemptsConsumed, 2, 'only the real failures should count')
    })

    it('presents the same idempotency key on every retry', async () => {
      // The property the whole design rests on: a retry of a step that may
      // already have succeeded must look identical to the provider.
      const keys: string[] = []
      const transient: FailureFacts = { code: 'ECONNRESET' }
      const flow = makeFlow([{ id: 'x', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({
        failures: [transient, transient, undefined],
        onInvoke: (ctx) => keys.push(ctx.idempotencyKey),
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      assert.equal(keys.length, 3)
      assert.equal(new Set(keys).size, 1, 'the idempotency key changed between retries')
    })

    it('gives up after the attempt budget and dead-letters the step', async () => {
      const transient: FailureFacts = { code: 'ECONNRESET' }
      const flow = makeFlow([
        { id: 'doomed', kind: 'noop', idempotent: true, maxAttempts: 3 },
      ])
      const handler = scriptedHandler({ failures: Array(10).fill(transient) })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'failed')

      const [step] = await listSteps(pool, run)
      assert.equal(step?.attemptsConsumed, 3)

      const dlq = await listDlqEntries(pool, { runId: run.id })
      assert.equal(dlq.length, 1, 'an exhausted step must reach the DLQ')
      assert.equal(dlq[0]?.reason, 'attempts_exhausted')

      const replay = dlq[0]?.replayPayload as Record<string, unknown>
      assert.equal(replay.nodeId, 'doomed')
      assert.ok(replay.idempotencyKey, 'the DLQ entry must carry enough to replay')
    })

    it('does not retry a client error', async () => {
      let invocations = 0
      const flow = makeFlow([{ id: 'bad-request', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({
        failures: Array(5).fill({ httpStatus: 422 } as FailureFacts),
        onInvoke: () => invocations++,
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      assert.equal(invocations, 1, 'a 422 will be a 422 next time too')
      assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'failed')
    })

    it('sends a poison payload straight to the DLQ without retrying', async () => {
      let invocations = 0
      const flow = makeFlow([{ id: 'poisonous', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({
        failures: Array(5).fill({ deterministicallyBroken: true } as FailureFacts),
        onInvoke: () => invocations++,
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      assert.equal(invocations, 1, 'poison must not go round the retry loop')
      const dlq = await listDlqEntries(pool, { runId: run.id })
      assert.equal(dlq[0]?.reason, 'poison')
    })

    it('does not consume an attempt when rate limited', async () => {
      const rateLimited: FailureFacts = { httpStatus: 429 }
      const flow = makeFlow([{ id: 'busy', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({
        failures: [rateLimited, rateLimited, rateLimited, undefined],
        output: 'through',
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'succeeded')
      const [step] = await listSteps(pool, run)
      assert.equal(step?.attemptsConsumed, 0, 'a 429 must not spend the retry budget')
      assert.equal(step?.deferrals, 3)
      assert.equal(step?.attemptsStarted, 4)
    })
  })

  describe('the ambiguous case', () => {
    it('pauses rather than retrying a timeout on a non-idempotent step', async () => {
      // The honest at-most-once path. We do not know whether the effect
      // happened, so a human decides instead of the engine guessing.
      let invocations = 0
      const flow = makeFlow([{ id: 'charge-card', kind: 'noop', idempotent: false }])
      const handler = scriptedHandler({
        failures: Array(5).fill({ deadlineExceeded: true } as FailureFacts),
        onInvoke: () => invocations++,
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      assert.equal(invocations, 1, 'a possibly-completed effect must not be repeated')
      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'waiting_confirmation')

      const [step] = await listSteps(pool, run)
      assert.equal(step?.status, 'waiting_confirmation')
      assert.equal(step?.attemptsConsumed, 0)
      assert.equal(await listDlqEntries(pool, { runId: run.id }).then((d) => d.length), 0)
    })

    it('retries the same failure when the step is idempotent', async () => {
      let invocations = 0
      const flow = makeFlow([{ id: 'safe-to-repeat', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({
        failures: [{ deadlineExceeded: true }, undefined],
        onInvoke: () => invocations++,
      })

      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, { noop: handler }), { tenantId })

      assert.equal(invocations, 2)
      assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'succeeded')
    })
  })

  describe('duplicate delivery', () => {
    it('makes a second delivery of the same step a no-op', async () => {
      // Matrix row: the queue hands the same message to two workers.
      let invocations = 0
      const flow = makeFlow([{ id: 'once', kind: 'noop', idempotent: true }])
      const handler = scriptedHandler({ failures: [], onInvoke: () => invocations++ })
      const executorDeps = deps(flow, { noop: handler })

      const run = await start(flow)
      // First drain dispatches advance_run, producing a run_step message.
      await drainQueue(pool, executorDeps, { tenantId, maxJobs: 1 })

      const [step] = await listSteps(pool, run)
      const duplicate = {
        runId: run.id,
        runStartedAt: run.startedAt,
        stepId: step!.id,
      }

      const { runStep } = await import('../src/engine/executor.ts')
      const [first, second] = await Promise.all([
        runStep(pool, duplicate, executorDeps),
        runStep(pool, duplicate, { ...executorDeps, workerId: 'other-worker' }),
      ])

      const outcomes = [first.kind, second.kind].sort()
      assert.deepEqual(outcomes, ['not_claimed', 'succeeded'])
      assert.equal(invocations, 1, 'the step executed twice')
    })
  })

  describe('cancellation', () => {
    it('stops advancing once cancellation is requested', async () => {
      let invocations = 0
      const flow = makeFlow(
        ['one', 'two', 'three'].map((id) => ({ id, kind: 'noop', idempotent: true })),
      )
      const handler = scriptedHandler({ failures: [], onInvoke: () => invocations++ })
      const executorDeps = deps(flow, { noop: handler })

      const run = await start(flow)
      // Let the first step run.
      await drainQueue(pool, executorDeps, { tenantId, maxJobs: 2 })
      await withTransaction(pool, (tx) => requestCancel(tx, run))
      await drainUntilQuiet(pool, executorDeps, { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'cancelled')
      assert.equal(invocations, 1, 'a step ran after cancellation')

      const steps = await listSteps(pool, run)
      assert.equal(steps.filter((s) => s.status === 'pending').length, 2)
    })
  })

  describe('crash recovery', () => {
    it('lets another worker finish a step abandoned mid-flight', async () => {
      // Simulates the worker dying after claiming: the lease is left behind
      // and lapses, and the step becomes claimable again with no intervention.
      const flow = makeFlow([{ id: 'orphan', kind: 'noop', idempotent: true }])
      const executorDeps = deps(flow, { noop: noopHandler })

      const run = await start(flow)
      await drainQueue(pool, executorDeps, { tenantId, maxJobs: 1 })
      const [step] = await listSteps(pool, run)

      // Claim it and then vanish, exactly as a killed process would.
      await withTransaction(pool, async (tx) => {
        const { claimStep } = await import('../src/engine/repository.ts')
        await claimStep(tx, {
          runStartedAt: run.startedAt,
          stepId: step!.id,
          workerId: 'doomed-worker',
          leaseMs: 30_000,
        })
      })

      const stranded = await listSteps(pool, run)
      assert.equal(stranded[0]?.status, 'running')

      // Time passes; the lease expires. Nothing is scheduled to notice —
      // the message that dispatched the step was consumed before the worker
      // died — so recovery depends entirely on the janitor.
      await advanceClock(pool, 120_000, tenantId)
      const report = await sweep(pool, { tenantId })
      assert.equal(report.expiredLeases, 1, 'the janitor did not see the lapsed lease')

      await drainUntilQuiet(pool, executorDeps, { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'succeeded', 'the abandoned step was never recovered')
    })
  })

  describe('losing the queue entirely', () => {
    it('recovers every non-terminal run after the outbox is wiped', async () => {
      // The invariant that makes the queue disposable: Postgres is the source
      // of truth, and the queue only carries pointers. Deleting every pointer
      // mid-run must cost latency, not work.
      const flow = makeFlow(
        ['p', 'q', 'r'].map((id) => ({ id, kind: 'noop', idempotent: true })),
      )
      const executorDeps = deps(flow, { noop: noopHandler })

      const run = await start(flow)
      await drainQueue(pool, executorDeps, { tenantId, maxJobs: 3 })

      const midway = await getRun(pool, run.startedAt, run.id)
      assert.equal(midway?.status, 'running', 'the run should be part-way through')

      // Simulate the queue being lost. Nothing is scheduled any more.
      await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenantId])
      const drainedNothing = await drainQueue(pool, executorDeps, { tenantId })
      assert.equal(drainedNothing.processed, 0, 'the queue should be empty')

      const report = await sweep(pool, { tenantId })
      assert.equal(report.strandedRuns, 1, 'the janitor did not notice the stranded run')

      await drainUntilQuiet(pool, executorDeps, { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'succeeded', 'a run was lost with the queue')
      assert.equal(finished?.stepsSucceeded, 3)
    })

    it('leaves finished runs alone', async () => {
      const flow = makeFlow([{ id: 'done', kind: 'noop', idempotent: true }])
      const executorDeps = deps(flow, { noop: noopHandler })
      const run = await start(flow)
      await drainUntilQuiet(pool, executorDeps, { tenantId })
      assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'succeeded')

      const report = await sweep(pool, { tenantId })
      assert.equal(report.strandedRuns, 0, 'the janitor tried to resurrect a finished run')
    })
  })

  describe('run deadline', () => {
    it('times out a run that outlives its budget', async () => {
      const flow = makeFlow([
        { id: 'slow-1', kind: 'noop', idempotent: true },
        { id: 'slow-2', kind: 'noop', idempotent: true },
      ])
      const executorDeps = deps(flow, { noop: noopHandler })

      const run = await start(flow, { runTimeoutMs: 60_000 })
      await drainQueue(pool, executorDeps, { tenantId, maxJobs: 2 })
      // Push the deadline into the past before the run can finish.
      await advanceClock(pool, 600_000, tenantId)
      await sweep(pool, { tenantId })
      await drainUntilQuiet(pool, executorDeps, { tenantId })

      const finished = await getRun(pool, run.startedAt, run.id)
      assert.equal(finished?.status, 'timed_out')
    })
  })
})
