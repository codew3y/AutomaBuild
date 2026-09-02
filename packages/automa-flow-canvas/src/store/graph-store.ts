/**
 * The graph store — the only undoable one.
 *
 * Three stores rather than one, and the split is the whole design:
 *
 *   graph      nodes, edges, node data      undoable
 *   editor     selection, viewport, panels  NOT undoable
 *   validation derived from graph           not state at all
 *
 * Putting viewport in the undo stack is the classic mistake, and it is not
 * subtle once you meet it: the user pans, types, panss again, presses ctrl-Z
 * expecting their typing back, and the canvas scrolls instead. Two more
 * presses and they have lost track entirely. `partialize` is what keeps it out.
 *
 * The second half is `handleSet` throttling. React Flow emits a position change
 * on every pointer move, so dragging one node fifty pixels produces dozens of
 * state updates. Untreated, one drag becomes forty undo steps and ctrl-Z
 * appears broken. Throttling coalesces the burst into one entry.
 *
 * Zustand's vanilla store is used rather than the React binding so all of this
 * is testable without a renderer — the semantics are the interesting part.
 */

import { createStore, type StoreApi } from 'zustand/vanilla'
import { temporal, type TemporalState } from 'zundo'
import {
  EMPTY_GRAPH,
  canConnect,
  type ConnectionCheck,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from '../core/graph.ts'

export interface GraphState {
  readonly nodes: readonly FlowNode[]
  readonly edges: readonly FlowEdge[]

  addNode(node: FlowNode): void
  removeNode(id: string): void
  /** Position updates during a drag. Coalesced into one undo entry. */
  moveNode(id: string, position: { x: number; y: number }): void
  /** Config changes. Committed on blur, not per keystroke. */
  updateNodeData(id: string, data: Readonly<Record<string, unknown>>): void

  connect(connection: {
    source: string
    target: string
    sourceHandle?: string
    targetHandle?: string
  }): ConnectionCheck
  removeEdge(id: string): void

  /** Replace everything — restoring a version, or loading a draft. */
  replaceGraph(graph: FlowGraph): void
  snapshot(): FlowGraph
}

export interface GraphStoreOptions {
  readonly initial?: FlowGraph
  /**
   * How long a burst of changes is coalesced into one undo entry.
   *
   * 300 ms is long enough to swallow a drag and short enough that two
   * deliberate edits stay separate.
   */
  readonly coalesceMs?: number
  readonly limit?: number
  /** Injected so throttling is testable without waiting. */
  readonly now?: () => number
}

export const DEFAULT_COALESCE_MS = 300

export type GraphStore = StoreApi<GraphState> & {
  temporal: StoreApi<TemporalState<Pick<GraphState, 'nodes' | 'edges'>>>
  /**
   * Close the coalescing window, so the next drag starts a fresh undo entry.
   *
   * Call on pointer-up. Two drags of the same node 100 ms apart are two
   * gestures and should be two undo steps, and only the UI knows where one
   * ended.
   */
  endGesture(): void
}

export function createGraphStore(options: GraphStoreOptions = {}): GraphStore {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS
  const limit = options.limit ?? 100
  const now = options.now ?? Date.now

  let lastRecordedAt = -Infinity
  // Set immediately before a change that belongs to a continuous gesture.
  // Read and cleared by handleSet below.
  let currentChangeIsContinuous = false
  // Whether the entry currently at the top of the undo stack came from a
  // continuous gesture. Only such an entry may absorb further changes.
  let lastRecordedWasContinuous = false

  const store = createStore<GraphState>()(
    temporal(
      (set, get) => ({
        nodes: options.initial?.nodes ?? EMPTY_GRAPH.nodes,
        edges: options.initial?.edges ?? EMPTY_GRAPH.edges,

        addNode(node) {
          set((state) => ({ nodes: [...state.nodes, node] }))
        },

        removeNode(id) {
          // Edges touching the node go with it. Leaving them would produce a
          // dangling edge, and — worse — undoing the deletion would have to
          // restore them from somewhere, so they belong in the same entry.
          set((state) => ({
            nodes: state.nodes.filter((node) => node.id !== id),
            edges: state.edges.filter((edge) => edge.source !== id && edge.target !== id),
          }))
        },

        moveNode(id, position) {
          // A drag emits a change per pointer move. Marked so handleSet can
          // coalesce the burst; every other operation is discrete and is
          // always recorded.
          currentChangeIsContinuous = true
          set((state) => ({
            // A new object, not a mutation. React Flow compares by reference,
            // and a node mutated in place silently does not re-render — which
            // looks like a rendering bug and is not one.
            nodes: state.nodes.map((node) =>
              node.id === id ? { ...node, position: { ...position } } : node,
            ),
          }))
        },

        updateNodeData(id, data) {
          set((state) => ({
            nodes: state.nodes.map((node) =>
              node.id === id ? { ...node, data: { ...node.data, ...data } } : node,
            ),
          }))
        },

        connect(connection) {
          const check = canConnect(get().snapshot(), connection)
          if (!check.valid) return check

          const edge: FlowEdge = {
            id: `${connection.source}->${connection.target}${
              connection.sourceHandle === undefined ? '' : `:${connection.sourceHandle}`
            }`,
            source: connection.source,
            target: connection.target,
            ...(connection.sourceHandle === undefined
              ? {}
              : { sourceHandle: connection.sourceHandle }),
            ...(connection.targetHandle === undefined
              ? {}
              : { targetHandle: connection.targetHandle }),
          }
          set((state) => ({ edges: [...state.edges, edge] }))
          return check
        },

        removeEdge(id) {
          set((state) => ({ edges: state.edges.filter((edge) => edge.id !== id) }))
        },

        replaceGraph(graph) {
          set({ nodes: graph.nodes, edges: graph.edges })
        },

        snapshot() {
          const { nodes, edges } = get()
          return { nodes, edges }
        },
      }),
      {
        limit,

        // Only the graph is undoable. Everything else — selection, viewport,
        // which panel tab is open — lives in the editor store, and if it were
        // here every pan would become an undo step.
        partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),

        // Coalesce a drag into one entry — but only a drag.
        //
        // A purely time-based throttle is not enough, and the way it fails is
        // instructive: add a node, then immediately drag it. Every drag change
        // falls inside the window opened by the *addition*, so none is
        // recorded, and a single undo jumps back past the node's creation
        // rather than back to where the drag began.
        //
        // So continuity is a property of the operation, not of the clock.
        // Discrete edits — add, connect, delete, commit a field — always
        // record and reset the window. Only position updates during a drag are
        // eligible to be swallowed, and only into a preceding position update.
        //
        // Throttled rather than debounced, so an edit followed immediately by
        // ctrl-Z still has something to undo.
        handleSet: (handleSetCallback) => {
          return (pastState, currentState) => {
            const continuous = currentChangeIsContinuous
            currentChangeIsContinuous = false

            const at = now()
            // Three conditions, and all three are needed.
            //
            //   continuous                 discrete edits are never merged
            //   lastRecordedWasContinuous  a drag may only be absorbed into a
            //                              preceding drag, never into the edit
            //                              that happened to come before it
            //   within the window          the burst is one gesture
            //
            // Dropping the middle condition is the subtle failure: add a node
            // and drag it immediately, and the first move falls inside the
            // window opened by the addition. Nothing records the position the
            // drag began at, so one undo jumps back past the node's creation.
            const absorb =
              continuous && lastRecordedWasContinuous && at - lastRecordedAt < coalesceMs
            if (absorb) return

            lastRecordedAt = at
            lastRecordedWasContinuous = continuous
            handleSetCallback(pastState, currentState)
          }
        },

        equality: (a, b) => a.nodes === b.nodes && a.edges === b.edges,
      },
    ),
  ) as GraphStore

  // Closing the window is per-store state, so it is attached here rather than
  // exported as a free function that would have to guess which store it meant.
  ;(store as GraphStore & { endGesture(): void }).endGesture = () => {
    lastRecordedWasContinuous = false
  }

  return store
}


