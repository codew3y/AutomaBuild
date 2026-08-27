/**
 * The worker loop.
 *
 * Same dispatch path the tests drive synchronously, wrapped in the two things
 * a long-running process needs: something to wake it, and a way to stop
 * without breaking anything.
 *
 * **Waking.** LISTEN/NOTIFY for latency, polling for correctness. NOTIFY is
 * not persisted and reaches only sessions connected at that instant, so a
 * listener that is reconnecting misses the notification with nothing anywhere
 * to record that it did. The poll interval is therefore a floor, not the
 * mechanism — the worst case is a step waiting one interval, never a step
 * waiting forever.
 *
 * **Stopping.** Graceful shutdown is not "stop taking work and exit". A step
 * in flight holds a lease; killing the process leaves that lease to expire,
 * which turns every deploy into a burst of duplicate work fifteen minutes
 * later. So: stop claiming, let in-flight steps finish, then exit. The drain
 * window is asserted at startup to be longer than a step attempt, because a
 * drain shorter than a step guarantees the thing it exists to prevent.
 */

import { Client, type Pool } from 'pg'
import type { DbConfig } from '../db/config.ts'
import { dbConfigFromEnv } from '../db/config.ts'
import { drainQueue } from './drain.ts'
import { sweep } from './janitor.ts'
import type { ExecutorDeps } from './executor.ts'
import { DEFAULT_TIMEOUTS, assertTimeoutsValid, type TimeoutConfig } from '../timeouts.ts'

export interface WorkerOptions {
  readonly tenantId?: string
  /** Backstop for missed notifications. Not the primary wake mechanism. */
  readonly pollIntervalMs?: number
  /** How often the janitor sweeps for lapsed leases and stranded runs. */
  readonly sweepIntervalMs?: number
  readonly batchSize?: number
  readonly timeouts?: TimeoutConfig
  readonly dbConfig?: DbConfig
  readonly onEvent?: (event: WorkerEvent) => void
}

export type WorkerEvent =
  | { readonly type: 'started'; readonly workerId: string }
  | { readonly type: 'drained'; readonly processed: number }
  | { readonly type: 'swept'; readonly rescheduled: number }
  | { readonly type: 'stopping'; readonly reason: string }
  | { readonly type: 'stopped'; readonly inFlight: number }
  | { readonly type: 'error'; readonly error: Error }

export interface Worker {
  readonly workerId: string
  /** Resolves once the loop has stopped and in-flight work has finished. */
  readonly done: Promise<void>
  /** Stop claiming new work, finish what is in flight, then resolve. */
  stop(reason?: string): Promise<void>
}

export function startWorker(pool: Pool, deps: ExecutorDeps, options: WorkerOptions = {}): Worker {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS
  // A worker whose timeouts are inverted should refuse to start rather than
  // discover it under load, months later, as mysterious duplicates.
  assertTimeoutsValid(timeouts)

  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  const sweepIntervalMs = options.sweepIntervalMs ?? 15_000
  const emit = options.onEvent ?? (() => {})

  let running = true
  let inFlight = 0
  let wake: (() => void) | null = null
  let listener: Client | null = null

  const nudge = (): void => {
    if (wake !== null) {
      wake()
      wake = null
    }
  }

  const waitForWork = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, pollIntervalMs)
      timer.unref?.()
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  /** A dedicated connection, because LISTEN occupies a session. */
  const startListening = async (): Promise<void> => {
    const client = new Client(options.dbConfig ?? dbConfigFromEnv())
    listener = client
    client.on('notification', (message) => {
      // An empty payload means the row had no tenant; take it either way.
      if (
        options.tenantId === undefined ||
        message.payload === undefined ||
        message.payload === '' ||
        message.payload === options.tenantId
      ) {
        nudge()
      }
    })
    client.on('error', (error) => {
      emit({ type: 'error', error })
      // The poll floor is what makes a dead listener survivable rather than
      // fatal, so this is logged and otherwise ignored.
    })
    await client.connect()
    await client.query('LISTEN outbox')
  }

  const loop = async (): Promise<void> => {
    emit({ type: 'started', workerId: deps.workerId })
    await startListening().catch((error: Error) => emit({ type: 'error', error }))

    let lastSweep = 0

    while (running) {
      try {
        inFlight++
        const report = await drainQueue(pool, deps, {
          ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
          ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
        })
        if (report.processed > 0) emit({ type: 'drained', processed: report.processed })

        const now = Date.now()
        if (now - lastSweep >= sweepIntervalMs) {
          lastSweep = now
          const swept = await sweep(pool, {
            ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
          })
          const rescheduled = swept.expiredLeases + swept.overdueRuns + swept.strandedRuns
          if (rescheduled > 0) emit({ type: 'swept', rescheduled })
        }

        if (report.processed === 0 && running) {
          await waitForWork()
        }
      } catch (error) {
        emit({ type: 'error', error: error as Error })
        // Never let one bad pass kill the loop; a worker that exits on an
        // error is a worker that stops recovering anything.
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      } finally {
        inFlight--
      }
    }

    if (listener !== null) {
      await listener.end().catch(() => {})
      listener = null
    }
    emit({ type: 'stopped', inFlight })
  }

  const done = loop()

  return {
    workerId: deps.workerId,
    done,
    async stop(reason = 'requested') {
      emit({ type: 'stopping', reason })
      running = false
      nudge()
      await done
    },
  }
}

/**
 * Wire SIGTERM and SIGINT to a graceful stop.
 *
 * The grace timer is the honest admission that draining can fail: if a step
 * hangs past the window the process exits anyway, and the lease expiring is
 * what recovers it. Better a known fifteen-minute delay than a worker that
 * refuses to die during a deploy.
 */
export function installSignalHandlers(
  worker: Worker,
  options: { graceMs?: number; onForce?: () => void } = {},
): () => void {
  const graceMs = options.graceMs ?? DEFAULT_TIMEOUTS.graceMs

  const handle = (signal: string) => () => {
    const timer = setTimeout(() => {
      options.onForce?.()
      process.exit(1)
    }, graceMs)
    timer.unref?.()
    void worker.stop(signal).then(() => clearTimeout(timer))
  }

  const onTerm = handle('SIGTERM')
  const onInt = handle('SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)

  return () => {
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
  }
}
