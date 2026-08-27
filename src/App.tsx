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
import { ancestors, canConnect, type FlowGraph } from './core/graph.ts'
import { canPublish, issuesByNode, validate, type ValidationIssue } from './core/validation.ts'
import { createAutosave, type SaveState } from './core/patch.ts'
import { outputTree, referenceFor, resolveTemplate } from './core/resolve.ts'
import { buildRunView, summarise, type RunRecord } from './core/run.ts'
import { nodeTypes } from './components/StepNode.tsx'
import { SAMPLE_FLOW, SAMPLE_OUTPUTS, SAMPLE_RUN, STEP_KINDS, SCHEMAS } from './sample.ts'
import './app.css'

const graphStore = createGraphStore({ initial: SAMPLE_FLOW })
const editorStore = createEditorStore()

const DRAFT_KEY = 'automa-flow-canvas:draft'

function Editor() {
  const nodes = useStore(graphStore, (state) => state.nodes)
  const edges = useStore(graphStore, (state) => state.edges)
  const selectedNodeId = useStore(editorStore, (state) => state.selectedNodeId)
  const mode = useStore(editorStore, (state) => state.mode)

  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [restored, setRestored] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  const canUndo = useStore(graphStore.temporal, (state) => state.pastStates.length > 0)
  const canRedo = useStore(graphStore.temporal, (state) => state.futureStates.length > 0)

  const graph = useMemo<FlowGraph>(() => ({ nodes, edges }), [nodes, edges])

  // Validation is derived, not stored. Storing it would mean keeping it in
  // sync, and a stale error highlighting the wrong node is worse than none.
  const issues = useMemo(() => validate(graph, { schemas: SCHEMAS }), [graph])
  const byNode = useMemo(() => issuesByNode(issues), [issues])
  const publishable = useMemo(() => canPublish(issues), [issues])

  /**
   * The run being viewed.
   *
   * Falls back to the bundled sample, but prefers a real one if a backend is
   * serving `/api/runs/latest`. That is the whole connection to the engine:
   * the canvas stays useful opened straight from a static host, and shows
   * genuine executions when there is something to show. A version that
   * *required* a server would be a worse portfolio piece — it would not open.
   */
  const [run, setRun] = useState<RunRecord>(SAMPLE_RUN)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('api/runs/latest')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: RunRecord | null) => {
        if (cancelled || data === null || !Array.isArray(data.steps)) return
        setRun(data)
        setLive(true)
      })
      .catch(() => {
        // No backend. The sample is the point of the fallback, not an error.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runView = useMemo(() => buildRunView(run), [run])
  const runSummary = useMemo(() => summarise(run), [run])
  const viewing = mode === 'run'

  const autosave = useRef(
    createAutosave({
      save: async () => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        localStorage.setItem(DRAFT_KEY, JSON.stringify(graphStore.getState().snapshot()))
      },
      onStateChange: setSaveState,
    }),
  ).current

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
    if (!viewing) autosave.schedule(graph)
  }, [graph, autosave, viewing])

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

  const deleteSelected = useCallback(() => {
    const id = editorStore.getState().selectedNodeId
    if (id === null) return
    graphStore.getState().removeNode(id)
    editorStore.getState().select(null)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)

      // Delete and Backspace remove the selected step — but never while a
      // field has focus, or backspacing a typo would delete the node.
      if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) {
        if (editorStore.getState().selectedNodeId !== null) {
          event.preventDefault()
          deleteSelected()
        }
        return
      }

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
  }, [deleteSelected])

  /* ------------------------------------------------ store → React Flow */

  const rfNodes = useMemo<Node[]>(() => {
    const source = viewing ? run.graph.nodes : nodes
    return source.map((node) => {
      const run = viewing ? runView.byNode.get(node.id) : undefined
      return {
        id: node.id,
        type: 'step',
        position: node.position,
        selected: node.id === selectedNodeId,
        deletable: !viewing,
        draggable: !viewing,
        data: {
          ...node.data,
          kind: node.kind,
          issueCount: viewing ? 0 : (byNode.get(node.id)?.length ?? 0),
          hasError: viewing
            ? false
            : (byNode.get(node.id) ?? []).some((issue) => issue.severity === 'error'),
          outcome: run?.outcome,
          durationMs: run?.durationMs,
        },
      }
    })
  }, [nodes, selectedNodeId, byNode, viewing, runView])

  const rfEdges = useMemo<Edge[]>(() => {
    const source = viewing ? run.graph.edges : edges
    return source.map((edge) => {
      const taken = viewing ? runView.takenEdgeIds.has(edge.id) : true
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
        ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
        label: edge.sourceHandle,
        animated: viewing && taken,
        deletable: !viewing,
        // The untaken branch is dimmed rather than hidden. Hiding it would
        // remove the very thing the viewer is meant to explain: that there was
        // another path and this run did not take it.
        style: viewing && !taken ? { opacity: 0.22, strokeDasharray: '4 4' } : undefined,
      }
    })
  }, [edges, viewing, runView])

  /* ------------------------------------------------ React Flow → store */

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (viewing) {
        for (const change of changes) {
          if (change.type === 'select') {
            editorStore.getState().select(change.selected ? change.id : null)
          }
        }
        return
      }
      const state = graphStore.getState()
      for (const change of changes) {
        if (change.type === 'position' && change.position !== undefined) {
          state.moveNode(change.id, change.position)
        } else if (change.type === 'remove') {
          state.removeNode(change.id)
          if (editorStore.getState().selectedNodeId === change.id) {
            editorStore.getState().select(null)
          }
        } else if (change.type === 'select') {
          editorStore.getState().select(change.selected ? change.id : null)
        }
      }
    },
    [viewing],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (viewing) return
      for (const change of changes) {
        if (change.type === 'remove') graphStore.getState().removeEdge(change.id)
      }
    },
    [viewing],
  )

  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      if (viewing) return false
      if (connection.source === null || connection.target === null) return false
      return canConnect(graphStore.getState().snapshot(), {
        source: connection.source,
        target: connection.target,
        ...(connection.sourceHandle == null ? {} : { sourceHandle: connection.sourceHandle }),
        ...(connection.targetHandle == null ? {} : { targetHandle: connection.targetHandle }),
      }).valid
    },
    [viewing],
  )

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source === null || connection.target === null) return
    graphStore.getState().connect({
      source: connection.source,
      target: connection.target,
      ...(connection.sourceHandle == null ? {} : { sourceHandle: connection.sourceHandle }),
      ...(connection.targetHandle == null ? {} : { targetHandle: connection.targetHandle }),
    })
  }, [])

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
        <strong className="brand">Automabuild</strong>

        <div className="modes">
          <button
            className={mode === 'edit' ? 'mode active' : 'mode'}
            onClick={() => editorStore.getState().setMode('edit')}
          >
            Edit
          </button>
          <button
            className={mode === 'run' ? 'mode active' : 'mode'}
            onClick={() => editorStore.getState().setMode('run')}
            title="View a past execution"
          >
            Run viewer
          </button>
        </div>

        {!viewing && (
          <div className="palette">
            {STEP_KINDS.map((kind) => (
              <button key={kind} onClick={() => addStep(kind)} title={`Add a ${kind} step`}>
                + {kind}
              </button>
            ))}
          </div>
        )}

        <div className="spacer" />

        {!viewing && (
          <>
            <button
              onClick={deleteSelected}
              disabled={selectedNodeId === null}
              title={selectedNodeId === null ? 'Select a step first' : 'Delete the selected step'}
            >
              Delete
            </button>
            <button onClick={() => graphStore.temporal.getState().undo()} disabled={!canUndo}>
              Undo
            </button>
            <button onClick={() => graphStore.temporal.getState().redo()} disabled={!canRedo}>
              Redo
            </button>

            <span className={`save save-${saveState}`}>
              {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'}
            </span>

            <button
              className="publish"
              disabled={!publishable}
              title={publishable ? 'Publish this version' : 'Fix the errors listed first'}
            >
              Publish
            </button>
          </>
        )}

        {viewing && (
          <span className="run-summary">
            {live ? '● live' : '○ sample'} · {run.id} · {runSummary.succeeded} ok ·{' '}
            {runSummary.notReached} not reached · {runSummary.totalMs} ms
          </span>
        )}
      </header>

      {restored && !viewing && (
        <div className="restored" role="status">
          <span>Draft restored from your last session.</span>
          <button
            className="dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setRestored(false)}
          >
            ✕
          </button>
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
          onNodeDoubleClick={(_event, node) => {
            if (viewing) return
            editorStore.getState().select(node.id)
            setSetupOpen(true)
          }}
          deleteKeyCode={null}
          nodesDraggable={!viewing}
          nodesConnectable={!viewing}
          elementsSelectable
          fitView
        >
          <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>

        <aside className="panel">
          {viewing ? (
            <RunPanel selectedId={selectedNodeId} run={run} live={live} />
          ) : (
            <EditPanel
              selected={selected}
              issues={issues}
              onDelete={deleteSelected}
              onOpenSetup={() => setSetupOpen(true)}
            />
          )}
        </aside>
      </div>

      {setupOpen && selected !== null && !viewing && (
        <SetupDialog
          nodeId={selected.id}
          kind={selected.kind}
          data={selected.data}
          onClose={() => setSetupOpen(false)}
          onDelete={() => {
            setSetupOpen(false)
            deleteSelected()
          }}
        />
      )}
    </div>
  )
}

/**
 * Setup as a dialog rather than a panel.
 *
 * Configuring a step and mapping data into it are different activities.
 * Mapping wants the canvas visible — you are looking at what came before —
 * so it stays in the panel. Setup is a focused edit of one thing, and putting
 * it in a modal gives it the width its fields want and a clear moment of
 * being finished.
 *
 * Escape closes, and the backdrop closes. Fields still commit on blur, so
 * closing does not discard what was typed.
 */
function SetupDialog({
  nodeId,
  kind,
  data,
  onClose,
  onDelete,
}: {
  nodeId: string
  kind: string
  data: Record<string, unknown>
  onClose: () => void
  onDelete: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        // Only a click that both starts and ends on the backdrop dismisses.
        // Otherwise dragging to select text inside the dialog and releasing
        // outside it would close the dialog mid-edit.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Configure ${nodeId}`}>
        <header className="dialog-header">
          <div>
            <strong>{String(data.label ?? nodeId)}</strong>
            <span className="muted">
              {' '}
              <code>{nodeId}</code> · {kind}
            </span>
          </div>
          <button className="dismiss" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="dialog-body">
          <StepForm key={nodeId} nodeId={nodeId} kind={kind} data={data} />
        </div>

        <footer className="dialog-footer">
          <button className="danger inline" onClick={onDelete}>
            Delete step
          </button>
          <div className="spacer" />
          <button onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ edit panel */

function EditPanel({
  selected,
  issues,
  onDelete,
  onOpenSetup,
}: {
  selected: { id: string; kind: string; data: Record<string, unknown> } | null
  issues: readonly ValidationIssue[]
  onDelete: () => void
  onOpenSetup: () => void
}) {
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warning')

  return (
    <>
      <section className="panel-section">
        <h2>Mapping</h2>
        {selected === null ? (
          <p className="muted">Select a step to map data into it.</p>
        ) : (
          <>
            <div className="selected-step">
              <span>
                <code>{selected.id}</code> · {selected.kind}
              </span>
              <button onClick={onOpenSetup} title="Open the setup dialog">
                Setup…
              </button>
            </div>
            <MappingPanel nodeId={selected.id} kind={selected.kind} data={selected.data} />
            <button className="danger" onClick={onDelete}>
              Delete this step
            </button>
          </>
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
 * The mapping panel.
 *
 * Two halves. The tree shows what earlier steps produced; clicking a leaf
 * inserts a reference into the field being edited. The preview shows what that
 * reference resolves to — which is the half that earns the panel, because
 * `{{ steps.fetch.output.email }}` tells you what you typed and
 * `sam@example.com` tells you whether it is right.
 *
 * Only *ancestors* are offered. Listing every step would invite exactly the
 * mapping the validation then rejects, which is a poor way to learn a rule.
 */
function MappingPanel({
  nodeId,
  kind,
  data,
}: {
  nodeId: string
  kind: string
  data: Record<string, unknown>
}) {
  const nodes = useStore(graphStore, (state) => state.nodes)
  const edges = useStore(graphStore, (state) => state.edges)
  const fields = SCHEMAS[kind]?.fields ?? []
  const [activeField, setActiveField] = useState(fields[0] ?? '')

  const available = useMemo(() => {
    const upstream = ancestors({ nodes, edges }, nodeId)
    const outputs: Record<string, unknown> = {}
    for (const id of upstream) {
      if (SAMPLE_OUTPUTS[id] !== undefined) outputs[id] = SAMPLE_OUTPUTS[id]
    }
    return outputs
  }, [nodes, edges, nodeId])

  const leaves = useMemo(() => outputTree(available), [available])
  const currentValue = String(data[activeField] ?? '')
  const preview = useMemo(
    () => resolveTemplate(currentValue, available),
    [currentValue, available],
  )

  const insert = useCallback(
    (path: string) => {
      if (activeField === '') return
      const next = `${currentValue}${currentValue.length > 0 ? ' ' : ''}${referenceFor(path)}`
      graphStore.getState().updateNodeData(nodeId, { [activeField]: next })
      graphStore.endGesture()
    },
    [activeField, currentValue, nodeId],
  )

  if (fields.length === 0) {
    return <p className="muted">This step has no fields to map into.</p>
  }

  return (
    <>
      <label className="field">
        <span>field</span>
        <select value={activeField} onChange={(event) => setActiveField(event.target.value)}>
          {fields.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
      </label>

      <div className="preview">
        <span className="preview-label">preview</span>
        {currentValue === '' ? (
          <em className="muted">empty</em>
        ) : preview.missing.length > 0 ? (
          <span className="preview-missing" title={`Unresolved: ${preview.missing.join(', ')}`}>
            {preview.text}
          </span>
        ) : (
          <span className="preview-value">
            {preview.single && typeof preview.value !== 'string'
              ? JSON.stringify(preview.value)
              : preview.text}
          </span>
        )}
      </div>

      <h2 className="tree-heading">Available from earlier steps</h2>
      {leaves.length === 0 ? (
        <p className="muted">
          Nothing runs before this step yet. Connect it to something upstream first.
        </p>
      ) : (
        <ul className="tree">
          {leaves.map((leaf) => (
            <li key={leaf.path} style={{ paddingLeft: `${(leaf.depth - 1) * 0.7}rem` }}>
              <button
                className="pill"
                onClick={() => insert(leaf.path)}
                disabled={leaf.kind === 'object' || leaf.kind === 'array'}
                title={
                  leaf.kind === 'object' || leaf.kind === 'array'
                    ? 'Pick a field inside this'
                    : `Insert ${referenceFor(leaf.path)}`
                }
              >
                <span className="pill-key">{leaf.key}</span>
                <span className={`pill-kind kind-${leaf.kind}`}>{leaf.kind}</span>
                {leaf.kind !== 'object' && leaf.kind !== 'array' && (
                  <span className="pill-value">{String(leaf.value)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* ------------------------------------------------------------- run panel */

function RunPanel({
  selectedId,
  run,
  live,
}: {
  selectedId: string | null
  run: RunRecord
  live: boolean
}) {
  const step = run.steps.find((candidate) => candidate.nodeId === selectedId) ?? null

  return (
    <>
      <section className="panel-section">
        <h2>Run {run.id}</h2>
        <p className="muted">
          {new Date(run.startedAt).toLocaleString()} · {run.status}
        </p>
        <p className="muted">
          {live
            ? 'A real execution, read from the engine.'
            : 'A bundled sample — no engine is reachable from here.'}{' '}
          Rendered on the graph <em>as it was</em> when it ran. The dimmed edge is the branch this
          run did not take.
        </p>
      </section>

      <section className="panel-section">
        <h2>Step</h2>
        {step === null ? (
          <p className="muted">Select a step to see what went in and what came out.</p>
        ) : (
          <>
            <p className="muted">
              <code>{step.nodeId}</code> ·{' '}
              <span className={`outcome outcome-${step.outcome}`}>{step.outcome}</span>
              {step.durationMs !== undefined && ` · ${step.durationMs} ms`}
              {step.attempts !== undefined && step.attempts > 1 && ` · ${step.attempts} attempts`}
            </p>

            {step.outcome === 'not_reached' && (
              <p className="muted">
                Never ran. The branch went the other way — nothing failed here.
              </p>
            )}

            {step.input !== undefined && (
              <>
                <h3>Input</h3>
                <pre>{JSON.stringify(step.input, null, 2)}</pre>
              </>
            )}
            {step.output !== undefined && (
              <>
                <h3>Output</h3>
                <pre>{JSON.stringify(step.output, null, 2)}</pre>
              </>
            )}
          </>
        )}
      </section>
    </>
  )
}

/* ----------------------------------------------------------------- form */

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

/**
 * Commits on blur, not on keystroke.
 *
 * Per-keystroke would put every character in the undo stack, so ctrl-Z would
 * delete one letter at a time, and would fire an autosave patch per character.
 */
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
