/**
 * The chaos demo. This is the test the repository exists to pass.
 *
 *   npm run demo:chaos
 *
 * Spawns worker processes, starts a batch of runs, and SIGKILLs a worker at
 * random while steps are in flight. SIGKILL specifically: no handler runs, no
 * lease is released, no result is written. From the database's point of view a
 * step is `running`, owned by a process that no longer exists — which is
 * exactly the state that makes naive engines either lose the work or do it
 * twice.
 *
 * Two things are checked at the end:
 *
 *   every run finished           nothing was lost
 *   every effect happened once   nothing was duplicated
 *
 * The second is the hard one. Two numbers matter in the summary:
 *
 *   steps re-executed      a kill abandoned a step and someone else took it
 *                          over. Recovery works.
 *   effect already done    that re-execution found its effect already
 *                          recorded under the same idempotency key and
 *                          declined to repeat it.
 *
 * The second number is the brief's first matrix row — killed after the call,
 * before the state write — and it is the case that becomes a duplicate charge
 * in an engine that assumes exactly-once delivery. The handler holds briefly
 * after its effect precisely so kills land there; without that the window is
 * too narrow to hit and the demo would look like a pass while proving less.
 *
 * A run with zero re-executions has proved nothing, and says so rather than
 * reporting a green tick.
 */

import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPool, withTransaction } from '../src/db/client.ts'
import { createRun, getRun, listSteps } from '../src/engine/repository.ts'
import { sweep } from '../src/engine/janitor.ts'
import type { FlowDefinition } from '../src/types.ts'

const RUNS = Number(process.env.CHAOS_RUNS ?? 25)
const WORKERS = Number(process.env.CHAOS_WORKERS ?? 4)
const KILL_EVERY_MS = Number(process.env.CHAOS_KILL_EVERY_MS ?? 400)
const MAX_MS = Number(process.env.CHAOS_DURATION_MS ?? 60_000)
const STEPS_PER_RUN = 4

const here = dirname(fileURLToPath(import.meta.url))
const pool = createPool()
const tenantId = randomUUID()

const flow: FlowDefinition = {
  id: randomUUID(),
  versionId: randomUUID(),
  nodes: Array.from({ length: STEPS_PER_RUN }, (_, i) => ({
    id: `step-${i}`,
    kind: 'noop',
    idempotent: true,
  })),
}

// Recreated rather than truncated: this is a demo scratch table, and an
// IF NOT EXISTS against an older shape silently keeps the old columns.
await pool.query('DROP TABLE IF EXISTS chaos_effects')
await pool.query(`
  CREATE TABLE chaos_effects (
    idempotency_key text PRIMARY KEY,
    run_id          uuid NOT NULL,
    node_id         text NOT NULL,
    worker_id       text NOT NULL,
    repeat_attempts integer NOT NULL DEFAULT 0,
    occurred_at     timestamptz NOT NULL DEFAULT now()
  )
`)

const childEnv = {
  ...process.env,
  CHAOS_TENANT_ID: tenantId,
  CHAOS_FLOW: JSON.stringify(flow),
}

const children = new Map<number, ChildProcess>()
let spawned = 0

function spawn(): void {
  const id = ++spawned
  const child = fork(join(here, 'chaos-worker.ts'), {
    env: { ...childEnv, CHAOS_WORKER_ID: `chaos-${id}` },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.set(id, child)
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text.length > 0) console.error(`  [chaos-${id}] ${text.split('\n')[0]}`)
  })
  child.on('exit', () => children.delete(id))
}

console.log(
  `chaos: ${RUNS} runs x ${STEPS_PER_RUN} steps, ${WORKERS} worker processes, SIGKILL every ${KILL_EVERY_MS}ms\n`,
)

for (let i = 0; i < WORKERS; i++) spawn()
await new Promise((resolve) => setTimeout(resolve, 1200))

const refs: Array<{ id: string; startedAt: Date }> = []
for (let i = 0; i < RUNS; i++) {
  const run = await withTransaction(pool, async (tx) => {
    const { run } = await createRun(tx, { tenantId, flow })
    return run
  })
  refs.push({ id: run.id, startedAt: run.startedAt })
}
console.log(`started ${refs.length} runs`)

let kills = 0
const killTimer = setInterval(() => {
  const alive = [...children.values()]
  if (alive.length === 0) return
  const victim = alive[Math.floor(Math.random() * alive.length)]!
  // No handler runs. The lease it holds is simply abandoned.
  victim.kill('SIGKILL')
  kills++
  setTimeout(spawn, 120)
}, KILL_EVERY_MS)

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out']
const settledCount = async (): Promise<number> => {
  let count = 0
  for (const ref of refs) {
    const run = await getRun(pool, ref.startedAt, ref.id)
    if (run !== null && TERMINAL.includes(run.status)) count++
  }
  return count
}

const started = Date.now()
// Kills stop halfway through, as a real incident ends. What matters is not
// that the system works while being destroyed, but that it converges once the
// destruction stops — with nothing lost and nothing done twice.
const killUntil = started + MAX_MS * 0.5
let killing = true
let settled = 0

while (Date.now() - started < MAX_MS) {
  if (killing && Date.now() > killUntil) {
    killing = false
    clearInterval(killTimer)
    console.log('\n  (kills stopped; letting the system settle)')
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  // Somebody has to notice leases abandoned by killed processes. In production
  // this is the janitor on its own timer; here it is on the demo's.
  await sweep(pool, { tenantId })
  settled = await settledCount()
  process.stdout.write(`\r  ${settled}/${refs.length} settled, ${kills} kills   `)
  if (settled === refs.length) break
}

if (killing) clearInterval(killTimer)
console.log('')

// Give whatever is still in flight a clear window with no kills.
for (let i = 0; i < 40 && settled < refs.length; i++) {
  await sweep(pool, { tenantId })
  await new Promise((resolve) => setTimeout(resolve, 400))
  settled = await settledCount()
}

for (const child of children.values()) child.kill('SIGKILL')

/* ------------------------------------------------------------ the verdict */

let succeeded = 0
let attempts = 0
for (const ref of refs) {
  const run = await getRun(pool, ref.startedAt, ref.id)
  if (run?.status === 'succeeded') succeeded++
  const steps = await listSteps(pool, ref)
  attempts += steps.reduce((sum, step) => sum + step.attemptsStarted, 0)
}

const { rows } = await pool.query<{ effects: string; repeats: string }>(
  `SELECT count(*)::text AS effects,
          COALESCE(sum(repeat_attempts), 0)::text AS repeats
     FROM chaos_effects`,
)
const effects = Number(rows[0]!.effects)
const repeats = Number(rows[0]!.repeats)
const expected = RUNS * STEPS_PER_RUN
const reExecuted = attempts - expected

console.log('\n' + '─'.repeat(60))
console.log(`workers SIGKILLed        ${kills}`)
console.log(`runs succeeded           ${succeeded}/${RUNS}`)
console.log(`step attempts made       ${attempts}  (for ${expected} steps)`)
console.log(`steps re-executed        ${reExecuted}`)
console.log(`  ...effect already done ${repeats}  (deduplicated by key)`)
console.log(`distinct side effects    ${effects}/${expected}`)
console.log('─'.repeat(60))

// Two different things, and conflating them hides what the demo proves.
//
//   reExecuted  a killed worker abandoned a step and another picked it up.
//               Evidence that recovery works at all.
//   repeats     the re-execution found its effect already recorded under the
//               same idempotency key, and declined to repeat it. Evidence
//               that at-least-once delivery did not become a duplicate.
//
// The second is a subset of the first, and much the rarer: most kills land
// before the effect, so the retry simply performs it for the first time.
const lost = succeeded < RUNS
const duplicated = effects > expected
const missing = effects < expected && !lost

if (lost) console.error(`\nFAIL: ${RUNS - succeeded} run(s) never finished — work was lost`)
if (duplicated) console.error(`\nFAIL: ${effects - expected} duplicate side effect(s)`)
if (missing) console.error(`\nFAIL: ${expected - effects} step(s) finished without their effect`)

if (!lost && !duplicated && !missing) {
  console.log('\nPASS — no work lost, no effect repeated.')
  if (reExecuted > 0) {
    console.log(
      `\n${reExecuted} step(s) ran more than once, and that is the point: a killed worker`,
    )
    console.log('left its lease behind, the janitor noticed, and another worker picked the')
    console.log('step up, presenting the same idempotency key so the effect happened once.')
    if (repeats > 0) {
      console.log(
        `\nOf those, ${repeats} found the effect already recorded and declined to repeat it.`,
      )
      console.log('That is the case that becomes a duplicate charge in a naive engine.')
    }
  } else {
    console.log('\nNOTE: no step was ever re-executed, so no kill landed mid-step and')
    console.log('recovery was never exercised. This run proves less than it looks.')
    console.log('Lower CHAOS_KILL_EVERY_MS or raise CHAOS_STEP_MIN_MS and run it again.')
  }
}

await pool.end()
process.exit(lost || duplicated || missing ? 1 : 0)
