/**
 * A worker as its own process, so it can be killed for real.
 *
 * The chaos demo spawns several of these and SIGKILLs them at random. That
 * matters: an in-process "kill" that awaits the in-flight step is a graceful
 * shutdown wearing a costume, and proves the drain works rather than the lease.
 * Only a process that dies mid-step leaves a lease held by nobody, which is
 * the situation the whole recovery design exists for.
 *
 * Reads its configuration from the environment because it is spawned, not
 * called.
 */

import { createPool } from '../src/db/client.ts'
import { startWorker } from '../src/engine/worker.ts'
import { DEFAULT_TIMEOUTS } from '../src/timeouts.ts'
import type { StepHandler } from '../src/engine/handlers.ts'
import type { FlowDefinition } from '../src/types.ts'

const workerId = process.env.CHAOS_WORKER_ID ?? 'chaos-worker'
const tenantId = process.env.CHAOS_TENANT_ID!
const flow = JSON.parse(process.env.CHAOS_FLOW!) as FlowDefinition
const minStepMs = Number(process.env.CHAOS_STEP_MIN_MS ?? 100)
const maxStepMs = Number(process.env.CHAOS_STEP_MAX_MS ?? 300)
// How long a step lingers after its side effect, before the result is written.
const afterEffectMs = Number(process.env.CHAOS_AFTER_EFFECT_MS ?? 250)

const pool = createPool()

/**
 * Records a side effect keyed by the step's idempotency key.
 *
 * The primary key is the assertion. A retry that presents the same key hits
 * the constraint and reports "already done" — at-least-once delivery, an
 * idempotent effect. A *different* key for the same step would insert twice,
 * and that is what the demo is looking for.
 *
 * The sleep before the insert widens the window where a kill lands after the
 * work has begun but before it is recorded, which is the dangerous moment.
 */
const handler: StepHandler = async (ctx) => {
  const duration = minStepMs + Math.floor(Math.random() * (maxStepMs - minStepMs))
  await new Promise((resolve) => setTimeout(resolve, duration))

  try {
    await pool.query(
      `INSERT INTO chaos_effects (idempotency_key, run_id, node_id, worker_id)
       VALUES ($1, $2, $3, $4)`,
      [ctx.idempotencyKey, ctx.run.id, ctx.node.id, workerId],
    )

    // Hold here, after the effect and before returning, so the executor has
    // not yet written the result.
    //
    // This is the exact window the whole design exists for: the side effect
    // has happened, and nothing durable records that it has. A worker killed
    // now leaves a step that looks untouched and an effect that already
    // occurred — the state where a naive engine sends the second invoice.
    // Without widening it deliberately, kills almost never land here and the
    // demo never exercises the case it is named after.
    await new Promise((resolve) => setTimeout(resolve, afterEffectMs))

    return { output: 'done' }
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      // Already performed under this key by an earlier attempt. The system
      // working as designed, not a duplicate.
      await pool.query(
        `UPDATE chaos_effects SET repeat_attempts = repeat_attempts + 1
          WHERE idempotency_key = $1`,
        [ctx.idempotencyKey],
      )
      return { output: 'already done' }
    }
    throw error
  }
}

/**
 * Timeouts scaled to the work.
 *
 * The lease is derived from the step deadline, so the production default of a
 * 60-second step means an abandoned step is unreclaimable for two minutes.
 * That is correct when steps call real APIs and wrong here, where they take
 * milliseconds: a demo that runs for ninety seconds would recover nothing and
 * report, accurately but uselessly, that everything was lost.
 *
 * The general rule this makes concrete: lease duration should be proportional
 * to how long a step actually takes, not to a global default.
 */
const timeouts = {
  ...DEFAULT_TIMEOUTS,
  httpCallMs: 2_000,
  stepAttemptMs: 4_000,
  drainMs: 5_000,
  graceMs: 6_000,
  runMs: 120_000,
}

const worker = startWorker(
  pool,
  { flow, handlers: { noop: handler }, workerId, timeouts },
  { tenantId, pollIntervalMs: 120, sweepIntervalMs: 500, timeouts },
)

// SIGTERM drains; the demo uses SIGKILL, which never reaches here.
process.on('SIGTERM', () => {
  void worker.stop('sigterm').then(async () => {
    await pool.end().catch(() => {})
    process.exit(0)
  })
})

process.send?.('ready')
await worker.done
