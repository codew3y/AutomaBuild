/**
 * Run history.
 *
 * The list the History tab shows. A listing is deliberately *not* a run with
 * the steps stripped off — it is what a server can produce from one row
 * without loading the step log, which is what makes a history of ten thousand
 * runs a cheap query instead of ten thousand joins.
 *
 * So the same shape has to be derivable two ways: computed by the server from
 * its own tables, and computed here from a `RunRecord` when the canvas is
 * running with no backend at all. `describeRun` is the second path, and the
 * server's SQL has to agree with it.
 */

import { summarise, type RunRecord } from './run.ts'

export interface RunListing {
  readonly id: string
  readonly startedAt: string
  readonly status: RunRecord['status']
  readonly succeeded: number
  readonly failed: number
  readonly notReached: number
  readonly totalMs: number
}

/** The listing for a run we already hold in full. */
export function describeRun(run: RunRecord): RunListing {
  const { succeeded, failed, notReached, totalMs } = summarise(run)
  return {
    id: run.id,
    startedAt: run.startedAt,
    status: run.status,
    succeeded,
    failed,
    notReached,
    totalMs,
  }
}

/**
 * Newest first.
 *
 * Ties break on id, descending, rather than being left to the sort's own
 * ordering. Runs started in the same millisecond are common — a webhook burst
 * produces them — and a list that reshuffles between two identical fetches
 * looks like data changing when nothing has.
 */
export function sortHistory(listings: readonly RunListing[]): RunListing[] {
  return [...listings].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1
    if (a.id === b.id) return 0
    return a.id < b.id ? 1 : -1
  })
}

/**
 * "4 min ago".
 *
 * `now` is a parameter because a function that reads the clock itself cannot
 * be tested, and because the value the viewer wants is relative to the moment
 * the page rendered, not to whenever this happens to be called.
 *
 * A future timestamp is not an error worth throwing over — clock skew between
 * a database and a browser is ordinary — so it reads as "just now" rather than
 * "in 3 seconds", which would look like a bug in the engine.
 */
export function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso

  const seconds = Math.round((now - then) / 1000)
  if (seconds < 45) return 'just now'

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`

  const days = Math.round(hours / 24)
  if (days < 30) return `${days} d ago`

  return iso.slice(0, 10)
}
