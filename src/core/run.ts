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

  return { succeeded, failed, notReached, totalMs }
}

/** Outputs of the steps that actually produced one, for the mapping preview. */
export function outputsFromRun(run: RunRecord): Record<string, { output: unknown }> {
  const outputs: Record<string, { output: unknown }> = {}
  for (const step of run.steps) {
    if (step.output !== undefined) outputs[step.nodeId] = { output: step.output }
  }
  return outputs
}
