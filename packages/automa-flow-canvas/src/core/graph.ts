/**
 * The graph, as data.
 *
 * Nothing here imports React or React Flow. That is deliberate: cycle
 * detection and ancestry are the parts that have to be *correct*, and they are
 * far easier to get right — and to test — when they are functions over plain
 * objects rather than behaviour tangled into a canvas component.
 *
 * The canvas converts to and from these shapes at its edges.
 */

export interface FlowNode {
  readonly id: string
  readonly kind: string
  readonly position: { readonly x: number; readonly y: number }
  readonly data: Readonly<Record<string, unknown>>
  /** Present only for nodes inside a container; see `assertParentsFirst`. */
  readonly parentId?: string
}

export interface FlowEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  /** Which output a branch node used. Undefined for a single-output node. */
  readonly sourceHandle?: string
  readonly targetHandle?: string
}

export interface FlowGraph {
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]
}

export const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] }

/** Adjacency in one direction, built once and reused by the walks below. */
function outgoing(graph: FlowGraph): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const node of graph.nodes) map.set(node.id, [])
  for (const edge of graph.edges) {
    const list = map.get(edge.source)
    // An edge pointing at a node that no longer exists is not a crash; it is a
    // stale edge, and `danglingEdges` reports it as a validation problem.
    if (list !== undefined) list.push(edge.target)
  }
  return map
}

function incoming(graph: FlowGraph): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const node of graph.nodes) map.set(node.id, [])
  for (const edge of graph.edges) {
    const list = map.get(edge.target)
    if (list !== undefined) list.push(edge.source)
  }
  return map
}

/** Every node reachable by following edges forward from `start`, excluding it. */
export function descendants(graph: FlowGraph, start: string): Set<string> {
  return walk(outgoing(graph), start)
}

/** Every node that can reach `start` by following edges forward, excluding it. */
export function ancestors(graph: FlowGraph, start: string): Set<string> {
  return walk(incoming(graph), start)
}

function walk(adjacency: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>()
  const stack = [...(adjacency.get(start) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    stack.push(...(adjacency.get(next) ?? []))
  }
  return seen
}

export type ConnectionRefusal =
  | 'self_loop'
  | 'would_create_cycle'
  | 'duplicate_edge'
  | 'unknown_node'
  | 'handle_already_used'

export interface ConnectionCheck {
  readonly valid: boolean
  readonly reason?: ConnectionRefusal
}

/**
 * May this connection be made?
 *
 * Called while the user is still dragging, which is the entire point. Reporting
 * "that created a cycle" *after* the drop means the graph passes through an
 * invalid state, something has to undo it, and the person is left wondering
 * what they did wrong. Refusing during the drag makes the edge simply not
 * attach — the interaction explains itself.
 *
 * A cycle would exist if the proposed target can already reach the proposed
 * source: adding source → target would close the loop. So the check is a
 * reachability query, not a full topological sort, and it runs on every
 * pointer move.
 */
export function canConnect(
  graph: FlowGraph,
  connection: { source: string; target: string; sourceHandle?: string; targetHandle?: string },
): ConnectionCheck {
  const { source, target } = connection

  if (source === target) return { valid: false, reason: 'self_loop' }

  const known = new Set(graph.nodes.map((node) => node.id))
  if (!known.has(source) || !known.has(target)) {
    return { valid: false, reason: 'unknown_node' }
  }

  // The cycle check comes before the handle check on purpose.
  //
  // Both can be true at once — dragging c back to a in a chain closes a loop
  // *and* lands on an input that is already taken. Reporting the occupied
  // handle would be accurate and useless: it describes a detail, while the
  // person is trying to do something the graph cannot express at all. Order
  // the refusals by how much they explain.
  if (descendants(graph, target).has(source)) {
    return { valid: false, reason: 'would_create_cycle' }
  }

  const duplicate = graph.edges.some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null),
  )
  if (duplicate) return { valid: false, reason: 'duplicate_edge' }

  // A step takes one input. Two edges into the same target handle would mean
  // two upstream steps racing to supply it, which the engine has no semantics
  // for — v1 is linear chains and branches, not joins.
  const targetOccupied = graph.edges.some(
    (edge) =>
      edge.target === target &&
      (edge.targetHandle ?? null) === (connection.targetHandle ?? null),
  )
  if (targetOccupied) return { valid: false, reason: 'handle_already_used' }

  return { valid: true }
}

/** Nodes with no incoming edge. A flow has exactly one: its trigger. */
export function roots(graph: FlowGraph): FlowNode[] {
  const hasIncoming = new Set(graph.edges.map((edge) => edge.target))
  return graph.nodes.filter((node) => !hasIncoming.has(node.id))
}

/**
 * The node the flow starts from.
 *
 * A well-formed flow has exactly one root; when it has several, the extras are
 * themselves the problem and `validate` reports them separately. Picking the
 * root that reaches the most nodes — ties broken by position in the array —
 * makes "which one is the real flow" deterministic rather than arbitrary.
 */
export function entryPoint(graph: FlowGraph): FlowNode | null {
  const candidates = roots(graph)
  if (candidates.length === 0) return null

  let best = candidates[0]!
  let bestReach = descendants(graph, best.id).size
  for (const candidate of candidates.slice(1)) {
    const reach = descendants(graph, candidate.id).size
    if (reach > bestReach) {
      best = candidate
      bestReach = reach
    }
  }
  return best
}

/**
 * Nodes with no path from the entry point — added and never wired up.
 *
 * Measured from the entry point, not from "any root". A disconnected node has
 * no incoming edge, so it *is* a root, and treating every root as reachable
 * would make every orphan reachable from itself — which is exactly the node
 * this is supposed to find.
 */
export function orphans(graph: FlowGraph, entryId?: string): FlowNode[] {
  const entry = entryId ?? entryPoint(graph)?.id
  if (entry === undefined) return []

  const reachable = new Set<string>([entry, ...descendants(graph, entry)])
  return graph.nodes.filter((node) => !reachable.has(node.id))
}

/**
 * The end of the chain that starts at the entry point.
 *
 * "Where would the next step go?" — and the answer has to survive a graph that
 * is mid-construction, because that is the only time anyone asks.
 *
 * Defining it as "the node with no outgoing edge" looked equivalent and was
 * not: a step dropped in open space also has no outgoing edge, so one loose
 * node made the answer ambiguous and the editor stopped offering anywhere to
 * drop — permanently, until the orphan was wired up or deleted. Walking
 * forward from the entry ignores orphans entirely, which is the right
 * treatment: they are not on the chain.
 *
 * Null when there is no single answer — no entry point at all, or a branch,
 * which has two ends and therefore no one place a next step belongs.
 */
export function chainTail(graph: FlowGraph): FlowNode | null {
  const entry = entryPoint(graph)
  if (entry === null) return null

  const next = outgoing(graph)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  let current = entry
  // Bounded by the node count: a cycle would otherwise walk forever, and a
  // cycle is a thing `validate` reports rather than something to crash on.
  for (let step = 0; step <= graph.nodes.length; step += 1) {
    const targets = next.get(current.id) ?? []
    if (targets.length === 0) return current
    if (targets.length > 1) return null

    const only = byId.get(targets[0]!)
    if (only === undefined) return null
    current = only
  }
  return null
}

/** Edges referring to a node that is not in the graph. */
export function danglingEdges(graph: FlowGraph): FlowEdge[] {
  const known = new Set(graph.nodes.map((node) => node.id))
  return graph.edges.filter((edge) => !known.has(edge.source) || !known.has(edge.target))
}

/**
 * Execution order, or null if the graph contains a cycle.
 *
 * Kahn's algorithm. `canConnect` should make a cycle unreachable through the
 * UI, but a graph can also arrive from an import or a restored version, and
 * those have not been through the drag-time check.
 */
export function topologicalOrder(graph: FlowGraph): FlowNode[] | null {
  const out = outgoing(graph)
  const indegree = new Map<string, number>()
  for (const node of graph.nodes) indegree.set(node.id, 0)
  for (const edge of graph.edges) {
    if (indegree.has(edge.target)) {
      indegree.set(edge.target, indegree.get(edge.target)! + 1)
    }
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const ordered: FlowNode[] = []

  while (ready.length > 0) {
    const id = ready.shift()!
    ordered.push(byId.get(id)!)
    for (const next of out.get(id) ?? []) {
      const remaining = indegree.get(next)! - 1
      indegree.set(next, remaining)
      if (remaining === 0) ready.push(next)
    }
  }

  return ordered.length === graph.nodes.length ? ordered : null
}

/**
 * React Flow requires a parent to appear before its children in the array.
 *
 * Violating it does not throw; children render detached from their container,
 * at the wrong coordinates, and the cause is not obvious from looking at
 * either. Asserted in development so the failure is a message rather than an
 * afternoon.
 */
export function assertParentsFirst(nodes: readonly FlowNode[]): void {
  const seen = new Set<string>()
  for (const node of nodes) {
    if (node.parentId !== undefined && !seen.has(node.parentId)) {
      throw new Error(
        `Node ${node.id} appears before its parent ${node.parentId}. React Flow requires ` +
          `parents earlier in the array; otherwise children render detached at the wrong position.`,
      )
    }
    seen.add(node.id)
  }
}
