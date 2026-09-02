/**
 * A branch, executed for real.
 *
 * The pure logic is covered in branching.test.ts. This is about the part that
 * only a database can answer: that the abandoned arm is *marked* skipped
 * rather than left pending, and that the run therefore finishes instead of
 * stalling on steps nothing will ever claim.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createPool, withTransaction } from '../src/db/client.ts'
import { createRun, getRun, listSteps } from '../src/engine/repository.ts'
import { drainUntilQuiet } from '../src/engine/drain.ts'
import { scriptedHandler } from '../src/engine/handlers.ts'
import { seededRandom } from '../src/random.ts'
import { evaluateCondition } from '../src/branching.ts'
import type { ExecutorDeps } from '../src/engine/executor.ts'
import type { FlowDefinition } from '../src/types.ts'
import type { StepHandler } from '../src/engine/handlers.ts'

const pool = createPool()
const tenantId = randomUUID()

before(async () => {
  await pool.query('SELECT 1')
})
after(async () => {
  await pool.end()
})

/** A branch handler of the shape the engine expects: it returns which arm. */
const branchHandler: StepHandler = async (context) => {
  const condition = String((context.node.config ?? {})['condition'] ?? '')
  const result = evaluateCondition(condition)
  if (!result.ok) throw new Error(result.reason)
  return { output: { taken: result.value ? 'yes' : 'no', condition } }
}

const flow = (condition: string): FlowDefinition => ({
  id: randomUUID(),
  versionId: randomUUID(),
  nodes: [
    { id: 'start', kind: 'noop', idempotent: true },
    { id: 'check', kind: 'branch', idempotent: true, config: { condition } },
    { id: 'premium', kind: 'noop', idempotent: true },
    { id: 'standard', kind: 'noop', idempotent: true },
    { id: 'finish', kind: 'noop', idempotent: true },
  ],
  edges: [
    { from: 'start', to: 'check' },
    { from: 'check', to: 'premium', arm: 'yes' },
    { from: 'check', to: 'standard', arm: 'no' },
    { from: 'premium', to: 'finish' },
    { from: 'standard', to: 'finish' },
  ],
})

async function run(condition: string) {
  const definition = flow(condition)
  const ran: string[] = []

  const started = await withTransaction(pool, async (tx) => {
    const { run } = await createRun(tx, { tenantId, flow: definition })
    return run
  })

  const deps: ExecutorDeps = {
    flow: definition,
    workerId: `worker-${randomUUID().slice(0, 8)}`,
    random: seededRandom(7),
    handlers: {
      noop: scriptedHandler({ failures: [], onInvoke: (ctx) => ran.push(ctx.node.id) }),
      branch: branchHandler,
    },
  }

  await drainUntilQuiet(pool, deps, { tenantId })

  const finished = await getRun(pool, started.startedAt, started.id)
  const steps = await listSteps(pool, started)
  const status = new Map(steps.map((step) => [step.nodeId, step.status]))
  return { finished, ran, status }
}

describe('running a branch', () => {
  it('runs the taken arm and marks the other skipped', async () => {
    const { finished, ran, status } = await run('premium = premium')

    assert.equal(finished?.status, 'succeeded')
    assert.deepEqual(ran, ['start', 'premium', 'finish'])
    assert.equal(status.get('premium'), 'succeeded')
    assert.equal(
      status.get('standard'),
      'skipped',
      'the abandoned arm must be marked, or it is indistinguishable from not-yet-reached',
    )
  })

  it('takes the other arm when the condition is false', async () => {
    const { finished, ran, status } = await run('basic = premium')

    assert.equal(finished?.status, 'succeeded')
    assert.deepEqual(ran, ['start', 'standard', 'finish'])
    assert.equal(status.get('premium'), 'skipped')
  })

  it('still runs the step where the arms rejoin', async () => {
    // The property the skip rule exists to preserve. `finish` is downstream of
    // the abandoned arm as well as the taken one; skipping it would silently
    // drop the rest of the flow.
    const { status } = await run('premium = premium')
    assert.equal(status.get('finish'), 'succeeded')
  })

  it('finishes rather than stalling on the steps nobody will claim', async () => {
    const { finished, status } = await run('4200 > 1000')
    assert.equal(finished?.status, 'succeeded')
    assert.equal([...status.values()].includes('pending'), false)
  })

  it('fails the branch when its condition cannot be evaluated', async () => {
    const { finished, status } = await run('premium > basic')
    assert.equal(finished?.status, 'failed')
    assert.equal(status.get('check'), 'failed')
    // And nothing past it ran.
    assert.equal(status.get('premium'), 'pending')
    assert.equal(status.get('standard'), 'pending')
  })
})
