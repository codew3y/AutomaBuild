/**
 * Resume-from-step and DLQ replay.
 *
 * The matrix row here is "resume-from-step preserves upstream outputs so
 * mappings still resolve" — which is only possible because step inputs and
 * outputs are persisted rather than held in a worker's memory.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool, withTransaction } from '../src/db/client.ts'
import { dbConfigFromEnv } from '../src/db/config.ts'
import { createRun, getRun, listDlqEntries, listSteps } from '../src/engine/repository.ts'
import { ResumeError, replayDlqEntry, resumeRun } from '../src/engine/resume.ts'
import { drainUntilQuiet } from '../src/engine/drain.ts'
import { scriptedHandler, type StepContext, type StepHandler } from '../src/engine/handlers.ts'
import { partitionHealth, assertPartitionHeadroom } from '../src/engine/janitor.ts'
import type { ExecutorDeps } from '../src/engine/executor.ts'
import { seededRandom } from '../src/random.ts'
import type { FailureFacts } from '../src/classify.ts'
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

describe('resume', { skip: SKIP }, () => {
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

  const flowOf = (ids: string[]): FlowDefinition => ({
    id: randomUUID(),
    versionId: randomUUID(),
    nodes: ids.map((id) => ({ id, kind: 'noop', idempotent: true })),
  })

  const start = (flow: FlowDefinition) =>
    withTransaction(pool, async (tx) => {
      const { run } = await createRun(tx, { tenantId, flow })
      return run
    })

  const deps = (flow: FlowDefinition, handler: StepHandler): ExecutorDeps => ({
    flow,
    handlers: { noop: handler },
    workerId: `w-${randomUUID().slice(0, 8)}`,
    random: seededRandom(11),
  })

  /** Records each node's output, and can be told which attempt to fail on. */
  const recording = (
    seen: Array<{ node: string; upstream: Record<string, unknown>; key: string }>,
    failures: Record<string, FailureFacts> = {},
  ): StepHandler => {
    return async (ctx: StepContext) => {
      seen.push({ node: ctx.node.id, upstream: { ...ctx.upstream }, key: ctx.idempotencyKey })
      const failure = failures[ctx.node.id]
      if (failure !== undefined) {
        const { StepFailure } = await import('../src/engine/handlers.ts')
        throw new StepFailure(`scripted ${ctx.node.id}`, failure)
      }
      return { output: `${ctx.node.id}-output` }
    }
  }

  it('preserves upstream outputs so downstream mappings still resolve', async () => {
    const flow = flowOf(['alpha', 'beta', 'gamma'])
    const first: Array<{ node: string; upstream: Record<string, unknown>; key: string }> = []

    // Run it through, failing at gamma so the run stops.
    const run = await start(flow)
    await drainUntilQuiet(
      pool,
      deps(flow, recording(first, { gamma: { httpStatus: 422 } })),
      { tenantId },
    )
    assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'failed')

    // Resume from beta. Alpha's output must survive.
    const result = await withTransaction(pool, (tx) =>
      resumeRun(tx, { runId: run.id, runStartedAt: run.startedAt, fromNodeId: 'beta' }),
    )
    assert.deepEqual(result.skipped, ['alpha'])
    assert.deepEqual(result.reset, ['beta', 'gamma'])

    const afterResume = await listSteps(pool, run)
    const alpha = afterResume.find((s) => s.nodeId === 'alpha')
    assert.equal(alpha?.status, 'skipped_resumed')
    assert.equal(alpha?.outputInline, 'alpha-output', 'the preserved output was discarded')

    const second: Array<{ node: string; upstream: Record<string, unknown>; key: string }> = []
    await drainUntilQuiet(pool, deps(flow, recording(second)), { tenantId })

    assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'succeeded')
    assert.deepEqual(
      second.map((entry) => entry.node),
      ['beta', 'gamma'],
      'alpha should not have run again',
    )

    // The whole point: beta could still see alpha's output.
    const betaRun = second.find((entry) => entry.node === 'beta')
    assert.equal(
      betaRun?.upstream.alpha,
      'alpha-output',
      'a downstream mapping referencing alpha would have failed',
    )
  })

  it('gives resumed steps new idempotency keys, because a replay is new intent', async () => {
    const flow = flowOf(['one', 'two'])
    const before: Array<{ node: string; upstream: Record<string, unknown>; key: string }> = []
    const run = await start(flow)
    await drainUntilQuiet(pool, deps(flow, recording(before, { two: { httpStatus: 400 } })), {
      tenantId,
    })

    const originalKeys = new Map(before.map((entry) => [entry.node, entry.key]))

    await withTransaction(pool, (tx) =>
      resumeRun(tx, { runId: run.id, runStartedAt: run.startedAt, fromNodeId: 'two' }),
    )

    const after: Array<{ node: string; upstream: Record<string, unknown>; key: string }> = []
    await drainUntilQuiet(pool, deps(flow, recording(after)), { tenantId })

    const replayedKey = after.find((entry) => entry.node === 'two')?.key
    assert.ok(replayedKey)
    assert.notEqual(
      replayedKey,
      originalKeys.get('two'),
      'a replay reused the original key, so a provider would decline the work',
    )
  })

  it('clears exhausted counters so the replay actually gets attempts', async () => {
    const flow: FlowDefinition = {
      id: randomUUID(),
      versionId: randomUUID(),
      nodes: [{ id: 'doomed', kind: 'noop', idempotent: true, maxAttempts: 2 }],
    }
    const run = await start(flow)
    await drainUntilQuiet(
      pool,
      deps(flow, recording([], { doomed: { code: 'ECONNRESET' } })),
      { tenantId },
    )
    const exhausted = await listSteps(pool, run)
    assert.equal(exhausted[0]?.attemptsConsumed, 2)

    await withTransaction(pool, (tx) =>
      resumeRun(tx, { runId: run.id, runStartedAt: run.startedAt, fromNodeId: 'doomed' }),
    )

    const reset = await listSteps(pool, run)
    assert.equal(reset[0]?.status, 'pending')
    assert.equal(reset[0]?.attemptsConsumed, 0, 'a replay must not start already exhausted')
    assert.equal(reset[0]?.attemptsStarted, 0)
    assert.equal(reset[0]?.errorClass, null)
  })

  it('refuses to resume a run that is still going', async () => {
    const flow = flowOf(['x'])
    const run = await start(flow)
    await assert.rejects(
      () =>
        withTransaction(pool, (tx) =>
          resumeRun(tx, { runId: run.id, runStartedAt: run.startedAt, fromNodeId: 'x' }),
        ),
      ResumeError,
    )
  })

  it('refuses a node that is not in the run', async () => {
    const flow = flowOf(['x'])
    const run = await start(flow)
    await drainUntilQuiet(pool, deps(flow, recording([], { x: { httpStatus: 400 } })), {
      tenantId,
    })
    await assert.rejects(
      () =>
        withTransaction(pool, (tx) =>
          resumeRun(tx, { runId: run.id, runStartedAt: run.startedAt, fromNodeId: 'nope' }),
        ),
      /has no step/,
    )
  })

  describe('DLQ replay', () => {
    it('re-runs a dead-lettered step and marks the entry resolved', async () => {
      const flow: FlowDefinition = {
        id: randomUUID(),
        versionId: randomUUID(),
        nodes: [
          { id: 'ok', kind: 'noop', idempotent: true },
          { id: 'flaky', kind: 'noop', idempotent: true, maxAttempts: 2 },
        ],
      }
      const run = await start(flow)
      await drainUntilQuiet(
        pool,
        deps(flow, recording([], { flaky: { code: 'ECONNRESET' } })),
        { tenantId },
      )

      const entries = await listDlqEntries(pool, { runId: run.id })
      assert.equal(entries.length, 1)

      await withTransaction(pool, (tx) => replayDlqEntry(tx, entries[0]!.id, 'tester'))

      // This time it works.
      await drainUntilQuiet(pool, deps(flow, recording([])), { tenantId })
      assert.equal((await getRun(pool, run.startedAt, run.id))?.status, 'succeeded')

      const stillOpen = await listDlqEntries(pool, { runId: run.id })
      assert.equal(stillOpen.length, 1, 'the entry should remain for the record')
    })

    it('refuses to replay the same entry twice', async () => {
      const flow: FlowDefinition = {
        id: randomUUID(),
        versionId: randomUUID(),
        nodes: [{ id: 'bad', kind: 'noop', idempotent: true, maxAttempts: 1 }],
      }
      const run = await start(flow)
      await drainUntilQuiet(pool, deps(flow, recording([], { bad: { code: 'ECONNRESET' } })), {
        tenantId,
      })
      const [entry] = await listDlqEntries(pool, { runId: run.id })
      assert.ok(entry)

      await withTransaction(pool, (tx) => replayDlqEntry(tx, entry.id, 'first'))
      await assert.rejects(
        () => withTransaction(pool, (tx) => replayDlqEntry(tx, entry.id, 'second')),
        /already replayed/,
      )
    })
  })
})

describe('partition health', { skip: SKIP }, () => {
  let pool: Pool
  before(() => {
    pool = createPool()
  })
  after(async () => {
    await pool.end()
  })

  it('reports days of partitions ahead of today', async () => {
    // Counted as days ahead, not total partitions: the total grows as history
    // accumulates and would look healthy while the future ran out.
    const health = await partitionHealth(pool)
    assert.equal(health.length, 2)
    for (const entry of health) {
      assert.ok(entry.daysAhead > 0, `${entry.table} has no future partitions`)
      assert.equal(entry.healthy, true)
    }
  })

  it('passes the headroom assertion on a healthy database', async () => {
    await assert.doesNotReject(() => assertPartitionHeadroom(pool))
  })

  it('reports an unknown table as starved rather than silently absent', async () => {
    const health = await partitionHealth(pool, ['not_a_table'])
    assert.deepEqual(health, [{ table: 'not_a_table', daysAhead: 0, healthy: false }])
    await assert.rejects(() => assertPartitionHeadroom(pool, ['not_a_table']), /headroom/)
  })
})
