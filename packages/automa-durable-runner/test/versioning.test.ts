/**
 * Publishing a new version while runs of the old one are in flight.
 *
 * A worker configured with a single `flow` looks every step up in that one
 * definition. That is fine until a flow can be republished, and then it is
 * quietly wrong: a run that started on version 1 would have its remaining
 * steps resolved against version 2 — different node ids, different config,
 * different idempotency — halfway through.
 *
 * `flows` resolves by the version the run was started on, which is recorded on
 * the run row and never changes. These tests are the reason that exists.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createPool, withTransaction } from '../src/db/client.ts'
import { createRun, getRun, listSteps } from '../src/engine/repository.ts'
import { drainUntilQuiet } from '../src/engine/drain.ts'
import { StepFailure, scriptedHandler } from '../src/engine/handlers.ts'
import { seededRandom } from '../src/random.ts'
import type { ExecutorDeps } from '../src/engine/executor.ts'
import type { FlowDefinition } from '../src/types.ts'

const pool = createPool()
const tenantId = randomUUID()
const flowId = randomUUID()

const version = (versionId: string, nodeIds: readonly string[]): FlowDefinition => ({
  id: flowId,
  versionId,
  nodes: nodeIds.map((id) => ({ id, kind: 'noop', idempotent: true, config: { versionId } })),
})

const V1 = randomUUID()
const V2 = randomUUID()

before(async () => {
  await pool.query('SELECT 1')
})

after(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('DELETE FROM outbox WHERE tenant_id = $1', [tenantId])
})

const start = (flow: FlowDefinition) =>
  withTransaction(pool, async (tx) => {
    const { run } = await createRun(tx, { tenantId, flow })
    return run
  })

const deps = (over: Partial<ExecutorDeps>): ExecutorDeps =>
  ({
    handlers: { noop: scriptedHandler({ failures: [] }) },
    workerId: `worker-${randomUUID().slice(0, 8)}`,
    random: seededRandom(1234),
    ...over,
  }) as ExecutorDeps

describe('resolving a flow by the version its run started on', () => {
  it('runs each run against the version it was created with', async () => {
    // Both runs exist before either is executed, which is the situation a
    // publish creates: version 1 work still queued when version 2 appears.
    const runV1 = await start(version(V1, ['a', 'b']))
    const runV2 = await start(version(V2, ['a', 'c']))

    const seen: { versionId: string; nodeId: string }[] = []
    const handler = scriptedHandler({
      failures: [],
      onInvoke: (ctx) => {
        seen.push({
          versionId: String((ctx.node.config ?? {})['versionId']),
          nodeId: ctx.node.id,
        })
      },
    })

    const registry: Record<string, FlowDefinition> = {
      [V1]: version(V1, ['a', 'b']),
      [V2]: version(V2, ['a', 'c']),
    }

    await drainUntilQuiet(
      pool,
      deps({ handlers: { noop: handler }, flows: (id) => registry[id] ?? null }),
      { tenantId },
    )

    const finishedV1 = await getRun(pool, runV1.startedAt, runV1.id)
    const finishedV2 = await getRun(pool, runV2.startedAt, runV2.id)
    assert.equal(finishedV1?.status, 'succeeded')
    assert.equal(finishedV2?.status, 'succeeded')

    // The node that only exists in v1 must have been resolved against v1, and
    // the one that only exists in v2 against v2.
    const b = seen.find((s) => s.nodeId === 'b')
    const c = seen.find((s) => s.nodeId === 'c')
    assert.equal(b?.versionId, V1, 'a v1 run resolved its step against the wrong version')
    assert.equal(c?.versionId, V2, 'a v2 run resolved its step against the wrong version')

    // And every step of a run saw exactly one version.
    assert.equal(new Set(seen.filter((s) => s.nodeId === 'a').map((s) => s.versionId)).size, 2)
  })

  it('fails a step deterministically when its version is gone', async () => {
    // Not a retryable condition: every attempt would look for the same missing
    // version, so burning five attempts to discover that helps nobody.
    const run = await start(version(V1, ['only']))

    await drainUntilQuiet(pool, deps({ flows: () => null }), { tenantId })

    const finished = await getRun(pool, run.startedAt, run.id)
    assert.equal(finished?.status, 'failed')

    const [step] = await listSteps(pool, run)
    assert.equal(step?.attemptsStarted, 1, 'a missing version must not be retried')
    assert.match(String(step?.errorMessage), /is not available/)
  })

  it('still accepts a single flow, which is the common case', async () => {
    const flow = version(V1, ['solo'])
    const run = await start(flow)

    await drainUntilQuiet(pool, deps({ flow }), { tenantId })

    const finished = await getRun(pool, run.startedAt, run.id)
    assert.equal(finished?.status, 'succeeded')
  })

  it('prefers the resolver when both are given', async () => {
    // A worker with both configured is ambiguous, and silently picking the
    // static one would reintroduce the bug this exists to prevent.
    const run = await start(version(V1, ['x']))

    let asked = false
    await drainUntilQuiet(
      pool,
      deps({
        flow: version(V2, ['x']),
        flows: (id) => {
          asked = true
          return version(id, ['x'])
        },
      }),
      { tenantId },
    )

    assert.equal(asked, true, 'the resolver must win over the static flow')
    const finished = await getRun(pool, run.startedAt, run.id)
    assert.equal(finished?.status, 'succeeded')
  })

  it('refuses to run with neither, rather than guessing', async () => {
    const run = await start(version(V1, ['x']))
    await assert.rejects(
      () => drainUntilQuiet(pool, deps({}), { tenantId }),
      /needs either flow or flows/,
    )
    void run
  })

  it('tolerates an async resolver, so a version can be fetched from a database', async () => {
    const flow = version(V1, ['async-step'])
    const run = await start(flow)

    await drainUntilQuiet(
      pool,
      deps({
        flows: async (id) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return id === V1 ? flow : null
        },
      }),
      { tenantId },
    )

    const finished = await getRun(pool, run.startedAt, run.id)
    assert.equal(finished?.status, 'succeeded')
  })
})

void StepFailure
