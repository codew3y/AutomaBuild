/**
 * The editor.
 *
 * The wiring worth reading is the boundary between the graph store and React
 * Flow. The store holds the document in its own shape; React Flow wants its
 * own. Converting at the edge — rather than storing React Flow's shape
 * directly — is what lets the graph logic be tested without a renderer, and
 * what stops the canvas library's data model leaking into validation.
 *
 * Performance rules from React Flow's own documentation, all easy to violate
 * by accident and all load-bearing at 150 nodes:
 *
 *   - `nodeTypes` is declared at module scope (see StepNode.tsx)
 *   - every callback is `useCallback`, every derived array `useMemo`
 *   - children read narrow slices, never the whole node array
 *   - a moved node is a new object, never mutated in place
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type IsValidConnection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useStore } from 'zustand'
import { createGraphStore } from './store/graph-store.ts'
import { createEditorStore } from './store/editor-store.ts'
import { canConnect, type FlowGraph } from './core/graph.ts'
import { canPublish, issuesByNode, validate, type ValidationIssue } from './core/validation.ts'
import { createAutosave, type SaveState } from './core/patch.ts'
import { nodeTypes } from './components/StepNode.tsx'
import { SAMPLE_FLOW, STEP_KINDS, SCHEMAS } from './sample.ts'
import './app.css'

const graphStore = createGraphStore({ initial: SAMPLE_FLOW })
const editorStore = createEditorStore()

/** Where a saved draft lives between refreshes. */
const DRAFT_KEY = 'automa-flow-canvas:draft'

function Editor() {
  const nodes = useStore(graphStore, (state) => state.nodes)
  const edges = useStore(graphStore, (state) => state.edges)
  const selectedNodeId = useStore(editorStore, (state) => state.selectedNodeId)

  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [restored, setRestored] = useState(false)

  // Undo depth, read narrowly so the toolbar re-renders without the canvas.
  const canUndo = useStore(graphStore.temporal, (state) => state.pastStates.length > 0)
  const canRedo = useStore(graphStore.temporal, (state) => state.futureStates.length > 0)

  const graph = useMemo<FlowGraph>(() => ({ nodes, edges }), [nodes, edges])

  // Validation is derived, not stored. Storing it would mean keeping it in
  // sync, and a stale error highlighting the wrong node is worse than none.
  const issues = useMemo(() => validate(graph, { schemas: SCHEMAS }), [graph])
  const byNode = useMemo(() => issuesByNode(issues), [issues])
  const publishable = useMemo(() => canPublish(issues), [issues])

  const autosave = useRef(
    createAutosave({
      // A mock backend, per the brief. localStorage is honest about being one:
      // it survives a refresh, which is the property the exit criterion cares
      // about, and nobody will mistake it for a server.
      save: async (_ops, _base) => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        localStorage.setItem(DRAFT_KEY, JSON.stringify(graphStore.getState().snapshot()))
      },
      onStateChange: setSaveState,
    }),
  ).current

  // Restore a draft once, before anything else can schedule a save.
  useEffect(() => {
    const saved = localStorage.getItem(DRAFT_KEY)
    if (saved !== null) {
      try {
        const parsed = JSON.parse(saved) as FlowGraph
        graphStore.getState().replaceGraph(parsed)
        autosave.reset(parsed)
        graphStore.temporal.getState().clear()
        setRestored(true)
      } catch {
        localStorage.removeItem(DRAFT_KEY)
      }
    } else {
      autosave.reset(graphStore.getState().snapshot())
    }
  }, [autosave])

  useEffect(() => {
    autosave.schedule(graph)
  }, [graph, autosave])

  // Blur and tab-hide flush immediately. A debounce alone loses the last edit
  // when someone closes the tab within 800 ms of making it — which is exactly
  // when people close tabs.
  useEffect(() => {
    const flush = () => {
      void autosave.flush().catch(() => {})
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [autosave])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === 'z' && !event.shiftKey) {
        event.preventDefault()
        graphStore.temporal.getState().undo()
      } else if (event.key === 'y' || (event.key === 'z' && event.shiftKey)) {
        event.preventDefault()
        graphStore.temporal.getState().redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ------------------------------------------------ store → React Flow */

  const rfNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: 'step',
        position: node.position,
        selected: node.id === selectedNodeId,
        // A new data object each time the issue set changes, so memoised nodes
        // re-render exactly when their own badge changes and not otherwise.
        data: {
          ...node.data,
          kind: node.kind,
          issueCount: byNode.get(node.id)?.length ?? 0,
          hasError: (byNode.get(node.id) ?? []).some((issue) => issue.severity === 'error'),
        },
      })),
    [nodes, selectedNodeId, byNode],
  )

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
        ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
        label: edge.sourceHandle,
        animated: false,
      })),
    [edges],
  )

  /* ------------------------------------------------ React Flow → store */

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const state = graphStore.getState()
    for (const change of changes) {
      if (change.type === 'position' && change.position !== undefined) {
        state.moveNode(change.id, change.position)
      } else if (change.type === 'remove') {
        state.removeNode(change.id)
      } else if (change.type === 'select') {
        editorStore.getState().select(change.selected ? change.id : null)
      }
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === 'remove') graphStore.getState().removeEdge(change.id)
    }
  }, [])

  /**
   * Refuse invalid connections *during* the drag.
   *
   * React Flow calls this continuously while the pointer moves, and a `false`
   * makes the target handle refuse the drop rather than accepting it and
   * reporting a problem afterwards. That difference is the whole exit
   * criterion: the graph never enters an invalid state.
   */
  const isValidConnection = useCallback<IsValidConnection>((connection) => {
    if (connection.source === null || connection.target === null) return false
    return canConnect(graphStore.getState().snapshot(), {
      source: connection.source,
      target: connection.target,
      ...(connection.sourceHandle === null || connection.sourceHandle === undefined
        ? {}
        : { sourceHandle: connection.sourceHandle }),
      ...(connection.targetHandle === null || connection.targetHandle === undefined
        ? {}
        : { targetHandle: connection.targetHandle }),
    }).valid
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null) return
    graphStore.getState().connect({
      source: connection.source,
      target: connection.target,
      ...(connection.sourceHandle === null || connection.sourceHandle === undefined
        ? {}
        : { sourceHandle: connection.sourceHandle }),
      ...(connection.targetHandle === null || connection.targetHandle === undefined
        ? {}
        : { targetHandle: connection.targetHandle }),
    })
  }, [])

  // Pointer-up closes the coalescing window, so the next drag is its own undo
  // entry rather than being merged into this one.
  const onNodeDragStop = useCallback(() => {
    graphStore.endGesture()
  }, [])

  const addStep = useCallback((kind: string) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`
    graphStore.getState().addNode({
      id,
      kind,
      position: { x: 120 + Math.random() * 320, y: 80 + Math.random() * 260 },
      data: { label: kind },
    })
    editorStore.getState().select(id)
  }, [])

  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  return (
    <div className="editor">
      <header className="toolbar">
        <strong>automa-flow-canvas</strong>

        <div className="palette">
          {STEP_KINDS.map((kind) => (
            <button key={kind} onClick={() => addStep(kind)} title={`Add a ${kind} step`}>
              + {kind}
            </button>
          ))}
        </div>

        <div className="spacer" />

        <button onClick={() => graphStore.temporal.getState().undo()} disabled={!canUndo}>
          Undo
        </button>
        <button onClick={() => graphStore.temporal.getState().redo()} disabled={!canRedo}>
          Redo
        </button>

        <span className={`save save-${saveState}`}>
          {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'}
        </span>

        <button className="publish" disabled={!publishable} title={
          publishable ? 'Publish this version' : 'Fix the errors below first'
        }>
          Publish
        </button>
      </header>

      {restored && (
        <div className="restored" role="status">
          Draft restored from your last session.
        </div>
      )}

      <div className="workspace">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          isValidConnection={isValidConnection}
          onPaneClick={() => editorStore.getState().select(null)}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={16} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>

        <aside className="panel">
          <Inspector selectedId={selected?.id ?? null} issues={issues} />
        </aside>
      </div>
    </div>
  )
}

/**
 * The inspector reads only what it needs.
 *
 * It takes the selected id rather than the node, and pulls that one node from
 * the store itself — so typing in a field re-renders this panel and nothing
 * else. Passing the whole node array down would re-render it on every drag of
 * every other node.
 */
function Inspector({
  selectedId,
  issues,
}: {
  selectedId: string | null
  issues: readonly ValidationIssue[]
}) {
  const node = useStore(
    graphStore,
    useCallback(
      (state: { nodes: readonly { id: string }[] }) =>
        selectedId === null ? null : state.nodes.find((n) => n.id === selectedId) ?? null,
      [selectedId],
    ),
  ) as { id: string; kind: string; data: Record<string, unknown> } | null

  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  return (
    <>
      <section className="panel-section">
        <h2>Step</h2>
        {node === null ? (
          <p className="muted">Select a step to configure it.</p>
        ) : (
          <StepForm key={node.id} nodeId={node.id} kind={node.kind} data={node.data} />
        )}
      </section>

      <section className="panel-section">
        <h2>
          Validation{' '}
          {errors.length > 0 && <span className="count count-error">{errors.length}</span>}
          {warnings.length > 0 && <span className="count count-warn">{warnings.length}</span>}
        </h2>
        {issues.length === 0 ? (
          <p className="muted">No problems. Ready to publish.</p>
        ) : (
          <ul className="issues">
            {issues.map((issue, index) => (
              <li key={index} className={`issue issue-${issue.severity}`}>
                <button onClick={() => issue.nodeId && editorStore.getState().select(issue.nodeId)}>
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

/**
 * Fields commit on blur, not on keystroke.
 *
 * Committing per keystroke would put every character in the undo stack, so
 * ctrl-Z would delete one letter at a time — and would fire an autosave patch
 * per character. The local value is component state until the field is left.
 */
function StepForm({
  nodeId,
  kind,
  data,
}: {
  nodeId: string
  kind: string
  data: Record<string, unknown>
}) {
  const fields = SCHEMAS[kind]?.fields ?? []

  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <p className="muted">
        <code>{nodeId}</code> · {kind}
      </p>
      {fields.map((field) => (
        <Field
          key={field}
          label={field}
          value={String(data[field] ?? '')}
          onCommit={(value) => {
            graphStore.getState().updateNodeData(nodeId, { [field]: value })
            graphStore.endGesture()
          }}
        />
      ))}
      {fields.length === 0 && <p className="muted">This step has nothing to configure.</p>}
    </form>
  )
}

function Field({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(value)
        }}
        placeholder={label === 'url' ? 'https://…  or  {{ steps.x.output.url }}' : ''}
      />
    </label>
  )
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  )
}
