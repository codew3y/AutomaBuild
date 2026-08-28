/**
 * Autosave as a patch against the last acknowledged draft.
 *
 * Sending the whole graph on every keystroke works until the graph is large,
 * and then it is a hundred kilobytes every 800 ms. A patch is small and — more
 * usefully — it says what *changed*, which is what a version history wants to
 * show.
 *
 * The patches are RFC 6902 shaped but computed **structurally, by node id**,
 * not by array index. That distinction matters more than it sounds: a
 * general-purpose differ handed two arrays produces index-based operations, so
 * inserting a node at the front rewrites every subsequent index and the patch
 * is both enormous and meaningless to read. Diffing by identity gives one
 * `add` — and survives reordering, which the canvas does whenever a node is
 * brought to the front.
 */

import type { FlowEdge, FlowGraph, FlowNode } from './graph.ts'

export type PatchOp =
  | { readonly op: 'add'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'replace'; readonly path: string; readonly value: unknown }

/** RFC 6901 escaping: `~` becomes `~0`, `/` becomes `~1`. */
function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]))
}

function shallowEqualNode(a: FlowNode, b: FlowNode): boolean {
  return (
    a.kind === b.kind &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.parentId === b.parentId &&
    JSON.stringify(a.data) === JSON.stringify(b.data)
  )
}

function shallowEqualEdge(a: FlowEdge, b: FlowEdge): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.sourceHandle === b.sourceHandle &&
    a.targetHandle === b.targetHandle
  )
}

/**
 * What changed between two graphs.
 *
 * An empty array means nothing did — which the autosave loop uses to avoid
 * sending a request every time a pointer moves over the canvas without
 * changing anything.
 */
export function diffGraph(before: FlowGraph, after: FlowGraph): PatchOp[] {
  const ops: PatchOp[] = []

  const beforeNodes = byId(before.nodes)
  const afterNodes = byId(after.nodes)

  for (const [id, node] of afterNodes) {
    const previous = beforeNodes.get(id)
    if (previous === undefined) {
      ops.push({ op: 'add', path: `/nodes/${escapePointer(id)}`, value: node })
    } else if (!shallowEqualNode(previous, node)) {
      ops.push({ op: 'replace', path: `/nodes/${escapePointer(id)}`, value: node })
    }
  }
  for (const id of beforeNodes.keys()) {
    if (!afterNodes.has(id)) {
      ops.push({ op: 'remove', path: `/nodes/${escapePointer(id)}` })
    }
  }

  const beforeEdges = byId(before.edges)
  const afterEdges = byId(after.edges)

  for (const [id, edge] of afterEdges) {
    const previous = beforeEdges.get(id)
    if (previous === undefined) {
      ops.push({ op: 'add', path: `/edges/${escapePointer(id)}`, value: edge })
    } else if (!shallowEqualEdge(previous, edge)) {
      ops.push({ op: 'replace', path: `/edges/${escapePointer(id)}`, value: edge })
    }
  }
  for (const id of beforeEdges.keys()) {
    if (!afterEdges.has(id)) {
      ops.push({ op: 'remove', path: `/edges/${escapePointer(id)}` })
    }
  }

  return ops
}

/**
 * Apply a patch. Used to reconstruct a version from its history, and by the
 * tests to prove a patch is faithful.
 */
export function applyPatch(graph: FlowGraph, ops: readonly PatchOp[]): FlowGraph {
  const nodes = byId(graph.nodes)
  const edges = byId(graph.edges)
  // Insertion order is preserved so a reconstructed graph keeps parents ahead
  // of their children, which React Flow requires.
  const nodeOrder = graph.nodes.map((node) => node.id)
  const edgeOrder = graph.edges.map((edge) => edge.id)

  for (const op of ops) {
    const [, collection, rawId] = op.path.split('/')
    if (rawId === undefined) continue
    const id = rawId.replace(/~1/g, '/').replace(/~0/g, '~')

    if (collection === 'nodes') {
      if (op.op === 'remove') {
        nodes.delete(id)
        nodeOrder.splice(nodeOrder.indexOf(id), 1)
      } else {
        if (!nodes.has(id)) nodeOrder.push(id)
        nodes.set(id, op.value as FlowNode)
      }
    } else if (collection === 'edges') {
      if (op.op === 'remove') {
        edges.delete(id)
        edgeOrder.splice(edgeOrder.indexOf(id), 1)
      } else {
        if (!edges.has(id)) edgeOrder.push(id)
        edges.set(id, op.value as FlowEdge)
      }
    }
  }

  return {
    nodes: nodeOrder.map((id) => nodes.get(id)!).filter(Boolean),
    edges: edgeOrder.map((id) => edges.get(id)!).filter(Boolean),
  }
}

export type SaveState = 'saved' | 'saving' | 'unsaved'

export interface AutosaveOptions {
  /** Send a patch. Resolves when the server has it. */
  readonly save: (ops: readonly PatchOp[], base: FlowGraph) => Promise<void>
  readonly debounceMs?: number
  readonly onStateChange?: (state: SaveState) => void
  /** Injected for tests. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export const DEFAULT_DEBOUNCE_MS = 800

/**
 * Debounced autosave against the last *acknowledged* draft.
 *
 * "Acknowledged" is the load-bearing word. The base advances only when a save
 * resolves — not when one is sent. If it advanced on send and the request then
 * failed, the next patch would be computed against a state the server never
 * received, and the difference would be silently lost: the local graph and the
 * saved one diverge with nothing to indicate it.
 *
 * `flush` exists for blur and tab-hide. A debounce alone means closing the tab
 * within 800 ms of the last keystroke loses it, and that is precisely when
 * people close tabs — right after finishing.
 */
export function createAutosave(options: AutosaveOptions) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never))

  let acknowledged: FlowGraph = { nodes: [], edges: [] }
  let pending: FlowGraph | null = null
  let timer: unknown = null
  let inFlight: Promise<void> | null = null
  let state: SaveState = 'saved'

  const setState = (next: SaveState) => {
    if (state === next) return
    state = next
    options.onStateChange?.(next)
  }

  async function send(): Promise<void> {
    if (pending === null) return
    const target = pending
    pending = null

    const ops = diffGraph(acknowledged, target)
    if (ops.length === 0) {
      setState('saved')
      return
    }

    setState('saving')
    const base = acknowledged
    try {
      await options.save(ops, base)
      // Only now. See the note above about acknowledgement.
      acknowledged = target
      setState(pending === null ? 'saved' : 'unsaved')
    } catch (error) {
      // The change is still pending, so the next flush retries it. Reverting
      // to 'unsaved' rather than showing an error keeps the indicator honest:
      // the work is not lost, it is not yet saved.
      pending = pending ?? target
      setState('unsaved')
      throw error
    }
  }

  return {
    /** Call on every graph change. Cheap; the debounce does the work. */
    schedule(graph: FlowGraph): void {
      pending = graph
      if (diffGraph(acknowledged, graph).length === 0) {
        setState(inFlight === null ? 'saved' : 'saving')
        return
      }
      setState('unsaved')
      if (timer !== null) clearTimer(timer)
      timer = setTimer(() => {
        timer = null
        inFlight = send().catch(() => {})
      }, debounceMs)
    },

    /** Save immediately. For blur, tab hide, and before publishing. */
    async flush(): Promise<void> {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      inFlight = send()
      await inFlight
      inFlight = null
    },

    get state(): SaveState {
      return state
    },

    /** The last state the server confirmed. */
    get acknowledged(): FlowGraph {
      return acknowledged
    },

    /**
     * Drop a pending save without performing it.
     *
     * For switching to a different document. `reset` clears `pending` but
     * leaves the debounce timer armed, and the timer's closure writes wherever
     * the *caller* currently points — so a save scheduled against one document
     * could land under the identity of the next one. Cancelling first is what
     * makes the handover safe.
     */
    cancel(): void {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      pending = null
      setState('saved')
    },

    /** Seed after loading an existing draft, so the first patch is a delta. */
    reset(graph: FlowGraph): void {
      acknowledged = graph
      pending = null
      setState('saved')
    },
  }
}
