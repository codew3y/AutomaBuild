/**
 * A past execution, for the run viewer.
 *
 * The distinction the viewer exists to make visible is *which path was taken*.
 * When someone says "the email never went out", the answer is usually not that
 * a step failed — it is that the branch went the other way and the step was
 * never reached. A viewer that only colours failures cannot show that; the
 * untaken path has to be visibly untaken.
 *
 * A run belongs to one flow *version*. Rendering it against the current design
 * would mean debugging yesterday's failure on today's diagram, where the step
 * being looked for may no longer exist — so a run carries the graph it ran on
 * rather than a reference to "the flow".
 */

import type { FlowGraph } from './graph.ts'

export type StepOutcome =
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'not_reached'
  | 'running'

export interface StepRun {
  readonly nodeId: string
  readonly outcome: StepOutcome
  readonly startedAt?: string
  readonly durationMs?: number
  readonly attempts?: number
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: string
}

export interface RunRecord {
  readonly id: string
  readonly startedAt: string
  /** Absent while the run is still going. */
  readonly finishedAt?: string
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'running'
  /** The graph as it was when this ran. */
  readonly graph: FlowGraph
  readonly steps: readonly StepRun[]
}

export interface RunView {
  readonly byNode: ReadonlyMap<string, StepRun>
  /** Edges on the path the run actually followed. */
  readonly takenEdgeIds: ReadonlySet<string>
  readonly reachedNodeIds: ReadonlySet<string>
}

/**
 * Work out which edges the run followed.
 *
 * An edge counts as taken when both ends were reached — which is what makes a
 * branch legible: the condition ran, one child has an outcome and the other
 * does not, so exactly one of the two edges lights up and the other is dimmed.
 */
export function buildRunView(run: RunRecord): RunView {
  const byNode = new Map(run.steps.map((step) => [step.nodeId, step]))

  const reached = new Set(
    run.steps
      .filter((step) => step.outcome !== 'not_reached' && step.outcome !== 'skipped')
      .map((step) => step.nodeId),
  )

  const taken = new Set(
    run.graph.edges
      .filter((edge) => reached.has(edge.source) && reached.has(edge.target))
      .map((edge) => edge.id),
  )

  return { byNode, takenEdgeIds: taken, reachedNodeIds: reached }
}

export interface RunSummary {
  readonly succeeded: number
  readonly failed: number
  readonly notReached: number
  readonly totalMs: number
}

/**
 * Counts, and how long the run took.
 *
 * `totalMs` is wall clock from start to finish when the run has finished, and
 * falls back to the sum of the step durations when it has not — or when the
 * record came from somewhere that does not carry a finish time.
 *
 * The two are genuinely different numbers: wall clock includes the wait
 * between steps and the backoff between retries, and the sum does not. Wall
 * clock is the one that answers "why did this take so long", so it wins where
 * both are available. What must not happen is the history list using one and
 * the header the other, which is what they did before this: the same run
 * showed two different totals on the same screen.
 */
export function summarise(run: RunRecord): RunSummary {
  let succeeded = 0
  let failed = 0
  let notReached = 0
  let totalMs = 0

  for (const step of run.steps) {
    if (step.outcome === 'succeeded') succeeded++
    else if (step.outcome === 'failed') failed++
    else if (step.outcome === 'not_reached') notReached++
    totalMs += step.durationMs ?? 0
  }

  const elapsed =
    run.finishedAt === undefined ? undefined : Date.parse(run.finishedAt) - Date.parse(run.startedAt)

  return {
    succeeded,
    failed,
    notReached,
    totalMs: elapsed === undefined || Number.isNaN(elapsed) || elapsed < 0 ? totalMs : elapsed,
  }
}

/** Outputs of the steps that actually produced one, for the mapping preview. */
export function outputsFromRun(run: RunRecord): Record<string, { output: unknown }> {
  const outputs: Record<string, { output: unknown }> = {}
  for (const step of run.steps) {
    if (step.output !== undefined) outputs[step.nodeId] = { output: step.output }
  }
  return outputs
}
