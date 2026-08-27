/**
 * Engine rows → the run viewer's shape.
 *
 * The viewer's contract is in `automa-flow-canvas/src/core/run.ts`, and the
 * part of it that matters is the distinction between a step that failed and a
 * step that was never reached. The engine has more statuses than the viewer
 * does, and flattening them carelessly is how "the email never went out"
 * turns into a screen that says everything succeeded.
 *
 * The mapping that is easy to get wrong: a `pending` step in a run that has
 * already finished was not "about to run" — the run ended without it. Reading
 * the step status alone cannot tell those apart, so the run status is part of
 * the decision.
 */

import type { RunRow, RunStatus, StepRow, StepStatus } from 'automa-durable-runner'

export type ViewerOutcome = 'succeeded' | 'failed' | 'skipped' | 'not_reached' | 'running'

export interface ViewerStep {
  readonly nodeId: string
  readonly outcome: ViewerOutcome
  readonly startedAt?: string
  readonly durationMs?: number
  readonly attempts?: number
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: string
}

export interface ViewerGraph {
  readonly nodes: readonly { readonly id: string; readonly kind: string; readonly position: { readonly x: number; readonly y: number }; readonly data?: Record<string, unknown> }[]
  readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string; readonly sourceHandle?: string }[]
}

export interface ViewerRun {
  readonly id: string
  readonly startedAt: string
  /** Absent while the run is still going. */
  readonly finishedAt?: string
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'running'
  readonly graph: ViewerGraph
  readonly steps: readonly ViewerStep[]
}

export interface ViewerListing {
  readonly id: string
  readonly startedAt: string
  readonly status: ViewerRun['status']
  readonly succeeded: number
  readonly failed: number
  readonly notReached: number
  readonly totalMs: number
}

/**
 * The engine has seven run statuses; the viewer has four.
 *
 * `timed_out` collapses into `failed` rather than getting its own colour,
 * because to the person reading it the flow did not do what it was supposed
 * to, and the reason is in the step. `waiting_confirmation` is a run still in
 * progress — not a terminal state to be shown as a result.
 */
export function toViewerRunStatus(status: RunStatus): ViewerRun['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
    case 'timed_out':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'queued':
    case 'running':
    case 'waiting_confirmation':
      return 'running'
  }
}

/**
 * A step's outcome, read in the context of the run that contains it.
 *
 * `runIsOver` is the parameter that makes `pending` answerable. In a live run
 * a pending step is still coming; in a finished one it never happened, and
 * "not reached" is precisely the fact the viewer exists to show.
 */
export function toViewerOutcome(status: StepStatus, runIsOver: boolean): ViewerOutcome {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'failed':
    case 'timed_out':
      return 'failed'
    // `skipped_resumed` is a step a resume deliberately passed over because it
    // had already succeeded. Showing it as skipped would suggest it did not
    // happen, when the opposite is true and its output is right there.
    case 'skipped_resumed':
      return 'succeeded'
    case 'skipped':
      return 'skipped'
    case 'cancelled':
      return 'not_reached'
    case 'pending':
      return runIsOver ? 'not_reached' : 'running'
    case 'dispatched':
    case 'running':
    case 'waiting_confirmation':
      return runIsOver ? 'not_reached' : 'running'
  }
}

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out']

export function toViewerRun(run: RunRow, steps: readonly StepRow[], graph: ViewerGraph): ViewerRun {
  const runIsOver = TERMINAL.includes(run.status)

  // Ordered by the engine's own topological order, which is the order they
  // ran. Sorting by anything else — node id, insertion — would make the viewer
  // disagree with the canvas about what came first.
  const ordered = [...steps].sort((a, b) => a.topoOrder - b.topoOrder)

  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    // The viewer computes a run's duration from these two, and falls back to
    // summing step durations without it — which is a different, smaller number.
    // Sending it is what keeps the history list and the header agreeing.
    ...(run.finishedAt === null ? {} : { finishedAt: run.finishedAt.toISOString() }),
    status: toViewerRunStatus(run.status),
    graph,
    steps: ordered.map((step) => {
      const error =
        step.errorMessage ??
        (step.errorClass === null ? undefined : `${step.errorClass}${step.errorCode === null ? '' : `: ${step.errorCode}`}`)

      return {
        nodeId: step.nodeId,
        outcome: toViewerOutcome(step.status, runIsOver),
        // Null rather than zero when the step never ran. A duration of 0 ms
        // and "never happened" render identically otherwise, and telling those
        // apart is the whole job of the viewer.
        ...(step.startedAt === null ? {} : { startedAt: step.startedAt.toISOString() }),
        ...(step.durationMs === null ? {} : { durationMs: step.durationMs }),
        // `attemptsStarted`, not `attemptsConsumed`: the viewer is answering
        // "how many times did this actually run", and a deferral that did not
        // consume an attempt still ran nothing. Started is the count of runs.
        attempts: step.attemptsStarted,
        ...(step.inputInline == null ? {} : { input: step.inputInline }),
        ...(step.outputInline == null ? {} : { output: step.outputInline }),
        ...(error === undefined || error === null ? {} : { error }),
      }
    }),
  }
}

/**
 * A listing, computed from the run row alone.
 *
 * This is the half that has to agree with `describeRun` in the canvas, and it
 * gets there without the step log — which is the entire reason a listing is a
 * separate shape. `notReached` is derived rather than counted: the engine
 * knows how many steps a run has and how many finished either way, and the
 * remainder is what never happened.
 */
export function toViewerListing(run: RunRow, totalMs = 0): ViewerListing {
  const accountedFor = run.stepsSucceeded + run.stepsFailed
  return {
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    status: toViewerRunStatus(run.status),
    succeeded: run.stepsSucceeded,
    failed: run.stepsFailed,
    notReached: Math.max(0, run.stepCount - accountedFor),
    totalMs,
  }
}
