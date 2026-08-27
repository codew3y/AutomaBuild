/**
 * Canvas graph → engine flow definition.
 *
 * This is the join between what someone drew and what the engine can run, and
 * the two disagree in ways worth being explicit about rather than papering
 * over:
 *
 *   - The canvas is a graph. The engine v1 executes a linear chain. A drawing
 *     with a branch in it is a valid drawing and not yet a runnable flow.
 *   - The canvas has a trigger node. The engine has no such concept — the
 *     trigger already happened; it is why there is a run at all. It compiles to
 *     a step anyway, one whose output is the payload that arrived, so the run
 *     viewer opens on "here is what came in" rather than mid-story, and so
 *     later steps can refer to it the way they refer to anything else.
 *
 * The compiler reports every problem it finds rather than throwing on the
 * first. Someone fixing a flow wants the list, not one error at a time.
 */

import type { FlowDefinition, FlowNode } from 'automa-durable-runner'

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
  // No transform or email executor exists yet. They compile to noop so the
  // shape of the run is right and the step is visibly present — and they warn,
  // because a step that silently does nothing is worse than one that is
  // missing.
  transform: 'noop',
  email: 'noop',
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

  // Walk the chain from the entry. `seen` guards against a cycle further down,
  // which entryPoints cannot detect on its own: a chain that loops back on
  // itself below the entry still leaves the entry untargeted.
  const chain: CanvasNode[] = []
  const seen = new Set<string>()
  let current: CanvasNode | undefined = entry

  while (current !== undefined) {
    if (seen.has(current.id)) {
      problems.push({ nodeId: current.id, message: 'The flow loops back on itself.' })
      break
    }
    seen.add(current.id)
    chain.push(current)

    if (current.kind === 'branch') {
      problems.push({
        nodeId: current.id,
        message:
          'The engine runs a single chain of steps; branches are not supported yet. ' +
          'Remove the branch, or split the flow in two.',
      })
      break
    }

    const next: CanvasEdge[] = outgoing.get(current.id) ?? []
    if (next.length > 1) {
      problems.push({
        nodeId: current.id,
        message: 'This step leads to more than one next step, and the engine runs one chain.',
      })
      break
    }
    current = next.length === 1 ? byId.get(next[0]!.target) : undefined
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
    if (executor === 'noop' && node.kind !== 'trigger') {
      warnings.push({
        nodeId: node.id,
        message: `A ${node.kind} step is recorded but does nothing yet — there is no executor for it.`,
      })
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

  return {
    ok: true,
    flow: { id: options.flowId, versionId: options.versionId, nodes },
    warnings,
  }
}
