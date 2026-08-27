/**
 * Canvas graph → engine flow definition.
 *
 * This is the join between what someone drew and what the engine can run, and
 * the two disagree in ways worth being explicit about rather than papering
 * over:
 *
 *   - The canvas is a graph and the engine executes steps in topological
 *     order, so the compiler flattens one into the other and hands over the
 *     edges as well, which is what lets a branch know what its untaken arm
 *     abandons.
 *   - The canvas has a trigger node. The engine has no such concept — the
 *     trigger already happened; it is why there is a run at all. It compiles to
 *     a step anyway, one whose output is the payload that arrived, so the run
 *     viewer opens on "here is what came in" rather than mid-story, and so
 *     later steps can refer to it the way they refer to anything else.
 *
 * The compiler reports every problem it finds rather than throwing on the
 * first. Someone fixing a flow wants the list, not one error at a time.
 */

import type { FlowDefinition, FlowEdge, FlowNode } from 'automa-durable-runner'

/** The canvas's shape. Mirrored, not imported: the editor ships to a browser
 *  and this runs on a server; a shared package for four interfaces would be
 *  more coupling than it saves. The tests pin them to each other. */
export interface CanvasNode {
  readonly id: string
  readonly kind: string
  readonly position: { readonly x: number; readonly y: number }
  readonly data?: Record<string, unknown>
}

export interface CanvasEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sourceHandle?: string
  readonly targetHandle?: string
}

export interface CanvasGraph {
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
}

export interface CompileProblem {
  readonly nodeId?: string
  readonly message: string
}

export type Compilation =
  | { readonly ok: true; readonly flow: FlowDefinition; readonly warnings: readonly CompileProblem[] }
  | { readonly ok: false; readonly problems: readonly CompileProblem[] }

/**
 * Whether repeating a step is safe.
 *
 * The default is `false`, and that is the whole point: the engine writes a
 * different set of error rows for a step it may not repeat, so guessing
 * optimistically here is how a duplicate charge happens. Only a GET is assumed
 * repeatable, and only because a GET that is not is already broken.
 */
function isIdempotent(node: CanvasNode): boolean {
  if (node.kind !== 'http') return false
  const method = String(node.data?.['method'] ?? 'GET').toUpperCase()
  return method === 'GET' || method === 'HEAD'
}

/** Which engine executor runs this canvas kind. */
const KIND_TO_EXECUTOR: Record<string, string> = {
  // Not `noop`: the trigger step's job is to make the payload that started the
  // run visible as an output, so that referring to the trigger like any other
  // step works, and so the run viewer opens on "here is what arrived" rather
  // than on the first thing that acted on it.
  trigger: 'trigger',
  http: 'http',
  transform: 'transform',
  email: 'email',
  branch: 'branch',
}

/**
 * Find the one node nothing points at.
 *
 * Not "the trigger": a graph can contain a trigger that something points at,
 * or two triggers, and calling one of them the entry point by kind would hide
 * that. Entry is a structural property, and it is checked as one.
 */
function entryPoints(graph: CanvasGraph): CanvasNode[] {
  const targeted = new Set(graph.edges.map((edge) => edge.target))
  return graph.nodes.filter((node) => !targeted.has(node.id))
}

export interface CompileOptions {
  readonly flowId: string
  readonly versionId: string
}

export function compileFlow(graph: CanvasGraph, options: CompileOptions): Compilation {
  const problems: CompileProblem[] = []
  const warnings: CompileProblem[] = []

  if (graph.nodes.length === 0) {
    return { ok: false, problems: [{ message: 'The flow is empty.' }] }
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))

  // An edge pointing at a node that is not there is a corrupt document, and
  // every check below would read past it, so it is caught first.
  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) {
      problems.push({ message: `Edge ${edge.id} starts at a step that does not exist.` })
    }
    if (!byId.has(edge.target)) {
      problems.push({ message: `Edge ${edge.id} ends at a step that does not exist.` })
    }
  }
  if (problems.length > 0) return { ok: false, problems }

  const entries = entryPoints(graph)
  if (entries.length === 0) {
    // Every node has an incoming edge, which for a finite graph means a cycle.
    return {
      ok: false,
      problems: [{ message: 'Every step has something before it, so the flow has no beginning.' }],
    }
  }
  if (entries.length > 1) {
    for (const entry of entries.slice(1)) {
      problems.push({
        nodeId: entry.id,
        message: `${entry.data?.['label'] ?? entry.id} is not connected to the trigger, so it would never run.`,
      })
    }
  }

  const entry = entries[0]!
  if (entry.kind !== 'trigger') {
    problems.push({
      nodeId: entry.id,
      message: 'A flow has to start at a trigger.',
    })
  }

  const outgoing = new Map<string, CanvasEdge[]>()
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.source)
    if (list === undefined) outgoing.set(edge.source, [edge])
    else list.push(edge)
  }

  // A depth-first walk that follows every edge, so both arms of a branch are
  // reached. `chain` ends up in topological order, which is the order the
  // engine executes in; `seen` guards against a cycle, which entryPoints
  // cannot detect on its own because a loop below the entry still leaves the
  // entry untargeted.
  const chain: CanvasNode[] = []
  const seen = new Set<string>()
  const onPath = new Set<string>()
  let cyclic = false

  const visit = (node: CanvasNode): void => {
    if (onPath.has(node.id)) {
      // Back to a node still on the current path: a genuine cycle, as opposed
      // to a join where two arms meet again.
      if (!cyclic) {
        cyclic = true
        problems.push({ nodeId: node.id, message: 'The flow loops back on itself.' })
      }
      return
    }
    if (seen.has(node.id)) return

    seen.add(node.id)
    onPath.add(node.id)

    for (const edge of outgoing.get(node.id) ?? []) {
      const target = byId.get(edge.target)
      if (target !== undefined) visit(target)
    }

    onPath.delete(node.id)
    // Prepended, so a node always lands before everything it leads to.
    chain.unshift(node)
  }

  visit(entry)

  for (const node of chain) {
    if (node.kind !== 'branch') {
      const next = outgoing.get(node.id) ?? []
      if (next.length > 1) {
        problems.push({
          nodeId: node.id,
          message: 'Only a branch step may lead to more than one next step.',
        })
      }
      continue
    }

    // A branch is defined by its two labelled arms. Anything else is a shape
    // the engine cannot resolve, and it is far better caught here than as a
    // run that stalls with both arms pending.
    const arms = (outgoing.get(node.id) ?? []).filter(
      (edge) => edge.sourceHandle === 'yes' || edge.sourceHandle === 'no',
    )
    const yes = arms.filter((edge) => edge.sourceHandle === 'yes')
    const no = arms.filter((edge) => edge.sourceHandle === 'no')

    if (yes.length !== 1 || no.length !== 1) {
      problems.push({
        nodeId: node.id,
        message:
          'A branch needs exactly one "yes" path and one "no" path. ' +
          `This one has ${yes.length} and ${no.length}.`,
      })
    }
    if (String(node.data?.['condition'] ?? '').trim() === '') {
      problems.push({ nodeId: node.id, message: 'A branch step needs a condition.' })
    }
  }

  // Anything the walk never reached is unreachable, whether it is stranded or
  // sitting behind a branch that stopped the walk.
  for (const node of graph.nodes) {
    if (!seen.has(node.id) && !problems.some((problem) => problem.nodeId === node.id)) {
      problems.push({
        nodeId: node.id,
        message: `${node.data?.['label'] ?? node.id} cannot be reached from the trigger.`,
      })
    }
  }

  for (const node of chain) {
    const executor = KIND_TO_EXECUTOR[node.kind]
    if (executor === undefined) {
      problems.push({ nodeId: node.id, message: `There is no executor for a ${node.kind} step.` })
      continue
    }
    if (node.kind === 'email') {
      if (String(node.data?.['to'] ?? '') === '') {
        problems.push({ nodeId: node.id, message: 'An email step needs a recipient.' })
      }
      if (String(node.data?.['body'] ?? '').trim() === '') {
        // Refused at compile time as well as at send time. An email with no
        // body reaches a person and says nothing, which is worse than a flow
        // that would not publish.
        problems.push({ nodeId: node.id, message: 'An email step needs a body.' })
      }
    }
    if (node.kind === 'transform') {
      const template = node.data?.['template'] ?? node.data?.['expression']
      if (String(template ?? '').trim() === '') {
        problems.push({ nodeId: node.id, message: 'A transform step needs a template.' })
      }
    }
    if (node.kind === 'http' && String(node.data?.['url'] ?? '') === '') {
      problems.push({ nodeId: node.id, message: 'An HTTP step needs a URL.' })
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  const nodes: FlowNode[] = chain.map((node) => ({
    id: node.id,
    kind: KIND_TO_EXECUTOR[node.kind]!,
    idempotent: isIdempotent(node),
    // The whole `data` object goes through, not a hand-picked subset. The
    // handler decides what it needs, and a compiler that filters is a second
    // place to update every time a step gains a field.
    config: { ...(node.data ?? {}), canvasKind: node.kind },
  }))

  // Only the edges between steps that made it into the flow. An edge to a
  // node the walk never reached would point at a step that does not exist.
  const included = new Set(chain.map((node) => node.id))
  const edges: FlowEdge[] = graph.edges
    .filter((edge) => included.has(edge.source) && included.has(edge.target))
    .map((edge) => ({
      from: edge.source,
      to: edge.target,
      ...(edge.sourceHandle === 'yes' || edge.sourceHandle === 'no'
        ? { arm: edge.sourceHandle }
        : {}),
    }))

  return {
    ok: true,
    flow: { id: options.flowId, versionId: options.versionId, nodes, edges },
    warnings,
  }
}
