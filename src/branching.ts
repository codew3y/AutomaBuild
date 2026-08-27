/**
 * Which steps a branch leaves behind.
 *
 * The engine executes steps in topological order, and every node of a flow
 * becomes a pending row when the run is created. A branch does not change that
 * — it decides which of the pending rows will never run, and those have to be
 * marked, because a step left `pending` in a finished run is indistinguishable
 * from one the run simply has not reached yet.
 *
 * The rule that makes this correct is narrower than it first looks. It is not
 * "everything downstream of the untaken edge": a branch whose two arms rejoin
 * has steps after the join that must still run, and skipping them because they
 * are downstream of the untaken arm would silently drop the rest of the flow.
 *
 * The rule is: skip what is reachable from the untaken arm and *not* reachable
 * from the taken one. A join point is reachable from both, so it survives.
 */

export interface FlowEdge {
  readonly from: string
  readonly to: string
  /**
   * Which arm of a branch this edge is.
   *
   * Absent on an ordinary edge. A branch node is expected to have exactly one
   * edge labelled `yes` and one labelled `no`; anything else is a flow the
   * compiler should have refused.
   */
  readonly arm?: 'yes' | 'no'
}

/** Everything reachable from a starting set, following edges forwards. */
export function reachableFrom(edges: readonly FlowEdge[], from: readonly string[]): Set<string> {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const list = outgoing.get(edge.from)
    if (list === undefined) outgoing.set(edge.from, [edge.to])
    else list.push(edge.to)
  }

  const seen = new Set<string>()
  const queue = [...from]

  while (queue.length > 0) {
    const node = queue.pop()!
    if (seen.has(node)) continue
    seen.add(node)
    // A cycle would loop forever without the seen check above. The compiler
    // refuses cycles, but this must not be the thing that depends on it.
    for (const next of outgoing.get(node) ?? []) queue.push(next)
  }

  return seen
}

/**
 * The node ids to mark skipped after a branch resolves.
 *
 * `taken` is the arm the condition selected. Anything reachable only through
 * the other arm never runs.
 */
export function stepsToSkip(
  edges: readonly FlowEdge[],
  branchNodeId: string,
  taken: 'yes' | 'no',
): string[] {
  const arms = edges.filter((edge) => edge.from === branchNodeId && edge.arm !== undefined)

  const takenHeads = arms.filter((edge) => edge.arm === taken).map((edge) => edge.to)
  const untakenHeads = arms.filter((edge) => edge.arm !== taken).map((edge) => edge.to)

  if (untakenHeads.length === 0) return []

  // Reachability from the taken side has to start at the branch's taken
  // successors, not at the branch itself — starting at the branch would reach
  // both arms and nothing would ever be skipped.
  const kept = reachableFrom(edges, takenHeads)
  const abandoned = reachableFrom(edges, untakenHeads)

  return [...abandoned].filter((node) => !kept.has(node)).sort()
}

/**
 * The condition language, which is deliberately tiny.
 *
 * `left op right`, where either side may be a literal and the references have
 * already been substituted by the time this sees them. Supported operators are
 * `=`, `!=`, `>`, `<`, `>=`, `<=`, plus a bare value tested for truthiness.
 *
 * Not an expression language, and not `eval`. A workflow engine that runs
 * user-supplied code needs a sandbox, and a sandbox is a much larger thing to
 * get right than a comparison. The cost is that some conditions cannot be
 * expressed; the benefit is that a flow definition can never be a way to run
 * code on the worker.
 */
export type ConditionResult = { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly reason: string }

const OPERATORS = ['>=', '<=', '!=', '=', '>', '<'] as const

/** Strip one layer of matching quotes, so `"premium"` compares as `premium`. */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  const first = trimmed[0]
  if ((first === '"' || first === "'") && trimmed.endsWith(first) && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Truthiness, in the terms a flow author would expect rather than JavaScript's. */
function truthy(raw: string): boolean {
  const value = unquote(raw).toLowerCase()
  // "false" and "0" are the two that JavaScript would call true as strings,
  // and that anyone writing a condition means as false.
  return value !== '' && value !== 'false' && value !== '0' && value !== 'null' && value !== 'undefined'
}

export function evaluateCondition(condition: string): ConditionResult {
  const source = condition.trim()
  if (source === '') return { ok: false, reason: 'the condition is empty' }

  for (const op of OPERATORS) {
    // `=` must not match the `=` inside `>=`, which is why the operator list
    // is ordered longest-first and `indexOf` is used rather than a split.
    const at = source.indexOf(op)
    if (at === -1) continue

    const left = unquote(source.slice(0, at))
    const right = unquote(source.slice(at + op.length))

    if (op === '=') return { ok: true, value: left === right }
    if (op === '!=') return { ok: true, value: left !== right }

    const a = Number(left)
    const b = Number(right)
    if (Number.isNaN(a) || Number.isNaN(b)) {
      return {
        ok: false,
        reason: `cannot compare ${JSON.stringify(left)} ${op} ${JSON.stringify(right)} as numbers`,
      }
    }

    if (op === '>') return { ok: true, value: a > b }
    if (op === '<') return { ok: true, value: a < b }
    if (op === '>=') return { ok: true, value: a >= b }
    return { ok: true, value: a <= b }
  }

  // No operator: the whole thing is a value, and the question is whether it is
  // set. `{{ steps.x.output.premium }}` reads naturally this way.
  return { ok: true, value: truthy(source) }
}
