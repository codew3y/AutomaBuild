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
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useStore } from 'zustand'
import { createGraphStore } from './store/graph-store.ts'
import { createEditorStore } from './store/editor-store.ts'
import { ancestors, canConnect, type FlowGraph } from './core/graph.ts'
import { canPublish, issuesByNode, validate, type ValidationIssue } from './core/validation.ts'
import { createAutosave, type SaveState } from './core/patch.ts'
import { outputTree, referenceFor, resolveTemplate } from './core/resolve.ts'
import { buildRunView, outputsFromRun, summarise, type RunRecord } from './core/run.ts'
import { describeRun, relativeTime, sortHistory, type RunListing } from './core/history.ts'
import { diffGraph } from './core/patch.ts'
import { apiFetch, readApiKey, writeApiKey, UnauthorizedError } from './core/api.ts'
import { KIND_ACCENT, nodeTypes } from './components/StepNode.tsx'
import { EMPTY_FLOW, SAMPLE_FLOW, SAMPLE_OUTPUTS, SAMPLE_RUN, STEP_KINDS, SCHEMAS } from './sample.ts'
import './app.css'

const graphStore = createGraphStore({ initial: SAMPLE_FLOW })
const editorStore = createEditorStore()

const DRAFT_KEY_BASE = 'automa-flow-canvas:draft'

/**
 * A draft belongs to one flow.
 *
 * A single key meant switching flows handed the second one the first one's
 * unsaved work, and publishing then wrote it to the wrong flow. The old key is
 * still read once for a draft saved before flows existed.
 */
const draftKeyFor = (flowId: string | null): string =>
  flowId === null ? DRAFT_KEY_BASE : `${DRAFT_KEY_BASE}:${flowId}`

export interface FlowSummary {
  readonly flowId: string
  readonly name: string
  readonly endpointId: string | null
  readonly scheme: string | null
  readonly isDefault: boolean
}

export interface WebhookInfo {
  readonly url: string
  readonly endpointId: string
  readonly scheme: string
  readonly signatureHeader: string
  readonly secretConfigured: boolean
}

/**
 * The address a trigger listens on.
 *
 * Rendered in the setup dialog for a trigger step and nowhere else, because
 * that is where someone goes when they ask "where do I send it". The secret is
 * deliberately absent: the server does not serve it, and a UI that displayed
 * one would be a UI that had been given one.
 */
function TriggerEndpoint({ webhook }: { readonly webhook: WebhookInfo | null }) {
  const [copied, setCopied] = useState(false)

  if (webhook === null) {
    return (
      <p className="muted endpoint-none">
        No server is connected, so this trigger has no address yet. Start the
        AutomaBuild server and reload.
      </p>
    )
  }

  return (
    <div className="endpoint">
      <span className="preview-label">webhook url</span>
      <code className="endpoint-url">{webhook.url}</code>

      <div className="endpoint-meta muted">
        <span>
          POST · signed with <code>{webhook.signatureHeader}</code> ({webhook.scheme})
        </span>
        {!webhook.secretConfigured && (
          <span className="endpoint-warn">No signing secret is configured on the server.</span>
        )}
      </div>

      <button
        onClick={() => {
          // clipboard is unavailable over plain http on some browsers, so a
          // failure here is expected rather than exceptional.
          navigator.clipboard?.writeText(webhook.url).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            () => setCopied(false),
          )
        }}
      >
        {copied ? 'Copied' : 'Copy URL'}
      </button>
    </div>
  )
}

/** What each kind is for, in the words someone building a flow would use. */
const KIND_BLURB: Record<string, string> = {
  http: 'Call an API',
  transform: 'Reshape the data',
  branch: 'Take one path or the other',
  email: 'Send a message',
}

const KIND_GLYPH: Record<string, string> = {
  http: '↗',
  transform: 'ƒ',
  branch: '⑂',
  email: '✉',
}

/**
 * Run history, in the left panel where the step library sits while building.
 *
 * The list is listings, not runs: picking one is what fetches its step log.
 * That is the difference between a history that stays usable at ten thousand
 * runs and one that downloads all of them to render a sidebar.
 */
function RunHistory({
  history,
  currentId,
  onPick,
  loading,
  live,
  now,
}: {
  readonly history: readonly RunListing[]
  readonly currentId: string
  readonly onPick: (id: string) => void
  readonly loading: boolean
  readonly live: boolean
  readonly now: number
}) {
  return (
    <aside className="library history">
      <div className="library-head">
        <h2>Runs</h2>
        <p className="muted">
          {live ? `${history.length} from the engine` : 'Sample run — no engine connected'}
        </p>
      </div>

      <ul className="library-list">
        {history.map((entry) => (
          <li key={entry.id}>
            <button
              className={entry.id === currentId ? 'run-row active' : 'run-row'}
              onClick={() => onPick(entry.id)}
              disabled={loading && entry.id === currentId}
            >
              <span className="run-row-top">
                <span className={`run-status status-${entry.status}`}>
                  {entry.status === 'succeeded'
                    ? '✓'
                    : entry.status === 'failed'
                      ? '✕'
                      : entry.status === 'running'
                        ? '…'
                        : '–'}
                </span>
                <span className="run-id">{entry.id}</span>
                <span className="run-when">{relativeTime(entry.startedAt, now)}</span>
              </span>
              <span className="run-row-bottom muted">
                {entry.succeeded} ok
                {entry.failed > 0 && <> · {entry.failed} failed</>}
                {entry.notReached > 0 && <> · {entry.notReached} not reached</>}
                {' · '}
                {entry.totalMs} ms
              </span>
            </button>
          </li>
        ))}
      </ul>

      {history.length === 0 && (
        <p className="library-foot muted">Nothing has run yet.</p>
      )}
    </aside>
  )
}

/**
 * The step library.
 *
 * Both gestures do the same thing, deliberately: dragging a card onto the
 * canvas drops the step where it lands, and clicking it adds one near the
 * middle. Drag is what the interface looks like it wants, but it is also the
 * gesture that fails silently on a trackpad someone is not used to, so click
 * stays as the one that always works.
 */
function StepLibrary({
  onAdd,
}: {
  readonly onAdd: (kind: string) => void
}) {
  return (
    <aside className="library">
      <div className="library-head">
        <h2>Steps</h2>
        <p className="muted">Drag onto the canvas, or click to add.</p>
      </div>

      <ul className="library-list">
        {STEP_KINDS.map((kind) => (
          <li key={kind}>
            <button
              className="library-card"
              draggable
              // The payload is the kind and nothing else; the drop handler owns
              // where the node goes, because only it knows the viewport.
              onDragStart={(event) => {
                event.dataTransfer.setData('application/automabuild-step', kind)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onClick={() => onAdd(kind)}
              style={{ '--accent': KIND_ACCENT[kind] } as React.CSSProperties}
              title={`Add a ${kind} step`}
            >
              <span className="library-glyph" aria-hidden="true">
                {KIND_GLYPH[kind] ?? '•'}
              </span>
              <span className="library-text">
                <span className="library-name">{SCHEMAS[kind]?.label ?? kind}</span>
                <span className="library-blurb">{KIND_BLURB[kind] ?? kind}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="library-foot muted">
        A flow starts at its trigger. Connect a step&rsquo;s left edge to the one
        that should run before it.
      </p>
    </aside>
  )
}

function Editor() {
  const nodes = useStore(graphStore, (state) => state.nodes)
  const edges = useStore(graphStore, (state) => state.edges)
  const selectedNodeId = useStore(editorStore, (state) => state.selectedNodeId)
  const mode = useStore(editorStore, (state) => state.mode)
  const leftPanelOpen = useStore(editorStore, (state) => state.leftPanelOpen)
  const rightPanelOpen = useStore(editorStore, (state) => state.rightPanelOpen)

  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [restored, setRestored] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)

  /**
   * What is live, and how the draft compares to it.
   *
   * `published` is the graph the server is running. `publishState` is the
   * request in flight. Divergence is derived from the two graphs rather than
   * stored, for the same reason validation is: a stored flag has to be kept in
   * sync, and one that says "published" while the draft has moved on is worse
   * than no indicator at all.
   */
  const [published, setPublished] = useState<{ versionId: string; graph: FlowGraph } | null>(null)
  const [publishState, setPublishState] = useState<'ready' | 'sending' | 'error'>('ready')
  const [publishError, setPublishError] = useState<string | null>(null)

  /**
   * Where a webhook should be sent.
   *
   * A trigger with no address is a step nobody can use: you can build the flow
   * and have no idea what to point at it. Null when there is no backend, in
   * which case the setup panel says so rather than showing a URL that is not
   * listening.
   */
  const [webhook, setWebhook] = useState<WebhookInfo | null>(null)

  /**
   * The flows this tenant has, and which one is open.
   *
   * `flowId` is null until the list arrives, and every request that needs a
   * scope waits for it. Guessing the default and correcting later would mean
   * the editor briefly showed one flow's runs under another's name.
   */
  const [flowList, setFlowList] = useState<readonly FlowSummary[]>([])
  const [flowId, setFlowId] = useState<string | null>(null)

  // The autosave closure is built once and outlives every flow switch, so it
  // reads the current flow through a ref. Capturing flowId directly would have
  // it writing this flow's draft under the id of whichever flow was open when
  // the editor started.
  const flowRef = useRef<string | null>(null)
  flowRef.current = flowId

  const autosave = useRef(
    createAutosave({
      save: async () => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        localStorage.setItem(draftKeyFor(flowRef.current), JSON.stringify(graphStore.getState().snapshot()))
      },
      onStateChange: setSaveState,
    }),
  ).current


  /**
   * Set when the server has refused the key we hold.
   *
   * A banner rather than a modal: the editor still works offline against its
   * own draft, and locking the whole screen over a missing credential would
   * stop someone doing the work they can still do.
   */
  const [needsKey, setNeedsKey] = useState(false)

  const { screenToFlowPosition } = useReactFlow()

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
  const [history, setHistory] = useState<readonly RunListing[]>([describeRun(SAMPLE_RUN)])
  const [loadingRun, setLoadingRun] = useState(false)

  // Fixed at mount, so every "4 min ago" in the list is relative to the same
  // instant. Recomputing per row would let two rows a millisecond apart
  // disagree about what "now" is.
  const renderedAt = useRef(Date.now()).current

  useEffect(() => {
    let cancelled = false

    // The listing and the latest run are two requests because they are two
    // different costs: the list is one cheap query, the run carries its whole
    // step log. Fetching them together would make opening the page pay for the
    // step log of a run nobody has asked to see yet — except that the viewer
    // does open on the latest one, so here it is worth it exactly once.
    Promise.all([
      apiFetch(`api/runs${scope}`)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
      apiFetch(`api/runs/latest${scope}`)
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null),
    ])
      .then(([listings, latest]: [RunListing[] | null, RunRecord | null]) => {
        if (cancelled) return
        // A run without steps is not a run this viewer can render, so it is
        // treated as no backend rather than as an empty run.
        if (latest !== null && Array.isArray(latest.steps)) {
          setRun(latest)
          setLive(true)
        }
        if (Array.isArray(listings) && listings.length > 0) {
          setHistory(sortHistory(listings))
          setLive(true)
        } else if (latest !== null && Array.isArray(latest.steps)) {
          // A backend that serves the latest run but no listing still gets a
          // one-row history rather than a list contradicting the canvas.
          setHistory([describeRun(latest)])
        }
      })
      .catch((error: unknown) => {
        if (error instanceof UnauthorizedError) setNeedsKey(true)
        // Otherwise there is no backend, and the sample is the point of the
        // fallback rather than an error.
      })

    return () => {
      cancelled = true
    }
  }, [])

  /** Everything scoped to a flow carries this. */
  const scope = flowId === null ? '' : `?flow=${encodeURIComponent(flowId)}`

  const loadFlows = useCallback((select?: string) => {
    apiFetch('api/flows')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: FlowSummary[] | null) => {
        if (!Array.isArray(data) || data.length === 0) return
        setFlowList(data)
        setFlowId((current) => {
          if (select !== undefined) return select
          // Keep the open flow across a refresh of the list; otherwise open the
          // default, and fall back to the first if there is no default.
          if (current !== null && data.some((flow) => flow.flowId === current)) return current
          return (data.find((flow) => flow.isDefault) ?? data[0]!).flowId
        })
      })
      .catch((error: unknown) => {
        if (error instanceof UnauthorizedError) setNeedsKey(true)
      })
  }, [])

  useEffect(() => {
    loadFlows()
  }, [loadFlows])

  useEffect(() => {
    if (flowId === null) return
    let cancelled = false
    apiFetch(`api/webhook${scope}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: WebhookInfo | null) => {
        if (cancelled || data === null || typeof data.url !== 'string') return
        setWebhook(data)
      })
      .catch((error: unknown) => {
        // A refused key is not the same as no server: one is fixable by typing
        // something, the other is not, and showing "no backend" for both would
        // send someone looking in entirely the wrong place.
        if (error instanceof UnauthorizedError) setNeedsKey(true)
      })
    return () => {
      cancelled = true
    }
  }, [flowId, scope])

  // What is live, fetched once. A 404 means nothing has been published yet,
  // which is a state rather than an error.
  useEffect(() => {
    if (flowId === null) return
    let cancelled = false

    // A flow with nothing published yet has no graph to show, and the previous
    // flow's must not be left on screen pretending to be this one's.
    setPublished(null)

    apiFetch(`api/flows/published${scope}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { versionId: string; graph: FlowGraph } | null) => {
        if (cancelled) return
        if (data === null || !Array.isArray(data.graph?.nodes)) {
          // Nothing published. Start from an empty canvas rather than the last
          // flow's steps, which would look like this flow already had them.
          if (localStorage.getItem(draftKeyFor(flowId)) === null) {
            graphStore.getState().replaceGraph(EMPTY_FLOW)
            graphStore.temporal.getState().clear()
            autosave.reset(EMPTY_FLOW)
          }
          return
        }
        setPublished({ versionId: data.versionId, graph: data.graph })

        // Open on what is live, unless there is unsaved local work.
        //
        // The editor used to open on its localStorage draft or, failing that,
        // the bundled sample — never on the published flow. So the canvas and
        // the server could show entirely different flows with nothing saying
        // so, and someone editing a step that was not in the live version had
        // no way to notice. A local draft still wins, because it is unsaved
        // work and losing it silently would be worse; the divergence indicator
        // and Discard are what surface the difference in that case.
        if (localStorage.getItem(draftKeyFor(flowId)) === null) {
          graphStore.getState().replaceGraph(data.graph)
          graphStore.temporal.getState().clear()
          autosave.reset(data.graph)
        }
      })
      .catch((error: unknown) => {
        if (error instanceof UnauthorizedError) setNeedsKey(true)
      })
    return () => {
      cancelled = true
    }
  }, [flowId, scope, autosave])

  /**
   * Has the draft moved away from what is live?
   *
   * Layout counts. Moving a node lights this up, and that is deliberate rather
   * than an oversight: the published graph is what the run viewer draws, so
   * positions are part of what gets published. A flow rearranged but not
   * published would otherwise show every past run on a layout nobody is
   * looking at any more.
   */
  const diverged = useMemo(() => {
    if (published === null) return false
    return diffGraph(published.graph, graph).length > 0
  }, [published, graph])

  const publish = useCallback(() => {
    setPublishState('sending')
    setPublishError(null)
    const snapshot = graphStore.getState().snapshot()

    apiFetch(`api/flows/published${scope}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ graph: snapshot }),
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          versionId?: string
          error?: string
          problems?: { message: string }[]
        }
        if (!response.ok) {
          // The server compiles too, and refuses things the editor's own
          // validation does not catch — a branch, for one. Showing its list
          // rather than a generic failure is the difference between "it did
          // not work" and knowing what to change.
          throw new Error(
            data.problems?.map((problem) => problem.message).join('; ') ??
              data.error ??
              `publish failed (${response.status})`,
          )
        }
        setPublished({ versionId: data.versionId!, graph: snapshot })
        setPublishState('ready')
      })
      .catch((error: unknown) => {
        if (error instanceof UnauthorizedError) setNeedsKey(true)
        setPublishError(error instanceof Error ? error.message : String(error))
        setPublishState('error')
      })
  }, [])

  /**
   * Go back to what is live.
   *
   * Through `replaceGraph`, which runs inside the store's temporal wrapper, so
   * this lands on the undo stack and ctrl-Z brings the work back. That is what
   * makes discarding safe enough not to need a modal — and it is easy to lose
   * by "optimising" the reset to bypass the store.
   */
  const discard = useCallback(() => {
    if (published === null) return
    graphStore.getState().replaceGraph(published.graph)
    graphStore.endGesture()
    editorStore.getState().select(null)
    setPublishError(null)
    setPublishState('ready')
  }, [published])

  const pickRun = useCallback(
    (id: string) => {
      if (id === run.id) return
      setLoadingRun(true)
      apiFetch(`api/runs/${encodeURIComponent(id)}${scope}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data: RunRecord | null) => {
          if (data === null || !Array.isArray(data.steps)) return
          setRun(data)
          // A run carries the graph it ran on, so selecting one from the
          // history is also what re-draws the canvas as it was then.
          editorStore.getState().select(null)
        })
        .catch(() => {
          // Leave the run that is already showing rather than blanking the
          // canvas; the row stays unselected, which is the visible signal.
        })
        .finally(() => setLoadingRun(false))
    },
    [run.id],
  )

  /**
   * What each step actually produced, for the mapping panel.
   *
   * The panel used to read a fixed table of sample outputs keyed by the sample
   * flow's node ids — `trigger`, `fetch`, `check`, `thanks`. Any step someone
   * added themselves got an id like `http-a3f2k`, which was not in that table,
   * so the panel offered nothing to map from and the feature was dead on every
   * flow that was not the sample.
   *
   * A real run is the honest source: it is what the fields actually contain.
   * The sample is kept underneath rather than replaced, so the panel still has
   * something to show on a flow that has never run, and so the editor opened
   * from a static host is not empty.
   */
  const mappingOutputs = useMemo(() => {
    const fromRun = outputsFromRun(run)
    return live ? { ...SAMPLE_OUTPUTS, ...fromRun } : SAMPLE_OUTPUTS
  }, [run, live])

  const runView = useMemo(() => buildRunView(run), [run])
  const runSummary = useMemo(() => summarise(run), [run])
  const viewing = mode === 'run'


  useEffect(() => {
    const saved = localStorage.getItem(draftKeyFor(flowRef.current))
    if (saved !== null) {
      try {
        const parsed = JSON.parse(saved) as FlowGraph
        graphStore.getState().replaceGraph(parsed)
        autosave.reset(parsed)
        graphStore.temporal.getState().clear()
        setRestored(true)
      } catch {
        localStorage.removeItem(draftKeyFor(flowRef.current))
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
      // Not named `run`: that shadowed the run being viewed, whose graph the
      // line above reads.
      const stepRun = viewing ? runView.byNode.get(node.id) : undefined
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
          outcome: stepRun?.outcome,
          durationMs: stepRun?.durationMs,
        },
      }
    })
  }, [nodes, selectedNodeId, byNode, viewing, run, runView])

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
  }, [edges, viewing, run, runView])

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

  const addStep = useCallback((kind: string, position?: { x: number; y: number }) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`
    graphStore.getState().addNode({
      id,
      kind,
      position: position ?? { x: 120 + Math.random() * 320, y: 80 + Math.random() * 260 },
      data: { label: kind },
    })
    editorStore.getState().select(id)
  }, [])

  // Dropping onto the canvas needs the pointer translated out of screen space
  // and into flow space, otherwise the node lands wherever the viewport
  // happens to be panned to rather than under the cursor.
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      if (viewing) return
      const kind = event.dataTransfer.getData('application/automabuild-step')
      // Anything else dragged in — a file, a text selection — is not ours.
      if (kind === '' || !STEP_KINDS.includes(kind as (typeof STEP_KINDS)[number])) return
      addStep(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [addStep, screenToFlowPosition, viewing],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    // Without preventDefault the browser refuses the drop and the card snaps
    // back with no explanation.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const selected = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  )

  return (
    <div className="editor">
      <header className="toolbar">
        {/*
          The toggle sits at the left edge, next to the panel it controls, so
          the thing it acts on is obvious without a tooltip. Its pressed state
          is on aria-pressed rather than only in the icon, because "is the
          panel open" is exactly what a screen reader user cannot see.
        */}
        <button
          className="panel-toggle"
          onClick={() => editorStore.getState().toggleLeftPanel()}
          aria-pressed={leftPanelOpen}
          aria-label={leftPanelOpen ? 'Hide the left panel' : 'Show the left panel'}
          title={leftPanelOpen ? 'Hide the left panel' : 'Show the left panel'}
        >
          ☰
        </button>

        <strong className="brand">Automabuild</strong>

        {/*
          Which flow is open. Only shown when a server is answering — without
          one there is a single local draft and nothing to switch between, and
          a picker with one permanent entry is furniture.
        */}
        {flowList.length > 0 && (
          <select
            className="flow-picker"
            value={flowId ?? ''}
            onChange={(event) => {
              const chosen = event.target.value
              if (chosen === '__new__') {
                const name = window.prompt('Name the new flow')
                if (name === null || name.trim() === '') return
                apiFetch('api/flows', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name: name.trim() }),
                })
                  .then(async (response) => {
                    const created = (await response.json()) as { flowId?: string; error?: string }
                    if (!response.ok) throw new Error(created.error ?? 'could not create the flow')
                    // Open it immediately: creating a flow and then having to
                    // find it in the list is a step nobody wants.
                    loadFlows(created.flowId)
                  })
                  .catch((error: unknown) => {
                    setPublishError(error instanceof Error ? error.message : String(error))
                  })
                return
              }
              editorStore.getState().select(null)
              setSetupOpen(false)
              setFlowId(chosen)
            }}
            title="Which flow you are editing"
          >
            {flowList.map((flow) => (
              <option key={flow.flowId} value={flow.flowId}>
                {flow.name}
              </option>
            ))}
            <option value="__new__">+ New flow…</option>
          </select>
        )}

        <div className="modes">
          <button
            className={mode === 'edit' ? 'mode active' : 'mode'}
            onClick={() => editorStore.getState().setMode('edit')}
            title="Build the flow"
          >
            Builder
          </button>
          <button
            className={mode === 'run' ? 'mode active' : 'mode'}
            onClick={() => editorStore.getState().setMode('run')}
            title="Past runs, and what each step did"
          >
            History
          </button>
        </div>

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

            {/*
              "Draft saved" rather than "Saved".

              This is about localStorage, and next to a button offering to
              publish, a bare "Saved" reads as "your changes are live" — two
              contradictory signals about the same flow. Naming the thing it
              actually refers to is what keeps them from arguing.
            */}
            <span className={`save save-${saveState}`}>
              {saveState === 'saved'
                ? 'Draft saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : 'Draft unsaved'}
            </span>

            {/*
              Three states, not two.

              Nothing published yet: one button that says Publish. Published
              and unchanged: a status, not a button, because pressing it would
              mint a version identical to the last. Published and diverged:
              publish the changes, or throw them away.

              Discard appears only when there is something to discard. A
              permanently visible one is noise almost all of the time.
            */}
            {published !== null && !diverged ? (
              <span className="published" title={`Live: version ${published.versionId}`}>
                ✓ Published
              </span>
            ) : (
              <>
                {diverged && (
                  <button
                    className="discard"
                    onClick={discard}
                    disabled={publishState === 'sending'}
                    title="Go back to the published version — ctrl-Z brings your changes back"
                  >
                    Discard
                  </button>
                )}
                <button
                  className="publish"
                  disabled={!publishable || publishState === 'sending'}
                  onClick={publish}
                  title={
                    publishable
                      ? 'Send this flow to the server; new runs will use it'
                      : 'Fix the errors listed first'
                  }
                >
                  {publishState === 'sending'
                    ? 'Publishing…'
                    : published === null
                      ? 'Publish'
                      : 'Publish changes'}
                </button>
              </>
            )}
          </>
        )}

        <button
          className="panel-toggle right"
          onClick={() => editorStore.getState().toggleRightPanel()}
          aria-pressed={rightPanelOpen}
          aria-label={rightPanelOpen ? 'Hide the right panel' : 'Show the right panel'}
          title={rightPanelOpen ? 'Hide the right panel' : 'Show the right panel'}
        >
          ☰
        </button>

        {viewing && (
          <span className="run-summary">
            {live ? '● live' : '○ sample'} · {run.id} · {runSummary.succeeded} ok ·{' '}
            {runSummary.notReached} not reached · {runSummary.totalMs} ms
          </span>
        )}
      </header>

      {needsKey && (
        <div className="restored needs-key" role="alert">
          <span>
            The server requires a key. Paste the value of <code>API_KEY</code>:
          </span>
          <input
            type="password"
            aria-label="API key"
            placeholder="API key"
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              const value = event.currentTarget.value.trim()
              if (value === '') return
              writeApiKey(value)
              // A reload rather than re-running each fetch by hand: several
              // requests failed, and re-issuing them individually is a list
              // that will fall out of step with the ones above.
              window.location.reload()
            }}
          />
          <button
            className="dismiss"
            aria-label="Dismiss"
            onClick={() => setNeedsKey(false)}
          >
            ✕
          </button>
        </div>
      )}

      {publishError !== null && !viewing && (
        <div className="restored publish-error" role="alert">
          <span>Publish failed: {publishError}</span>
          <button
            className="dismiss"
            aria-label="Dismiss"
            onClick={() => {
              setPublishError(null)
              setPublishState('ready')
            }}
          >
            ✕
          </button>
        </div>
      )}

      {restored && !viewing && (
        <div className="restored" role="status">
          <span>
            Draft restored from your last session
            {published !== null && diverged
              ? ' — it differs from the published flow.'
              : '.'}
          </span>
          {published !== null && diverged && (
            <button
              onClick={() => {
                discard()
                setRestored(false)
              }}
              title="Replace this draft with the flow the server is running"
            >
              Load published
            </button>
          )}
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
        {!leftPanelOpen ? null : viewing ? (
          <RunHistory
            history={history}
            currentId={run.id}
            onPick={pickRun}
            loading={loadingRun}
            live={live}
            now={renderedAt}
          />
        ) : (
          <StepLibrary onAdd={addStep} />
        )}

        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onDrop={onDrop}
          onDragOver={onDragOver}
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

        {/*
          Hidden unless asked for.

          Mapping lives in the setup dialog now, beside the fields it fills in,
          so there is nothing here a single click needs. What is left is
          validation and the run viewer — both worth reaching deliberately, and
          neither worth a permanent column of canvas.
        */}
        {rightPanelOpen && (
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
        )}
      </div>

      {setupOpen && selected !== null && !viewing && (
        <SetupDialog
          nodeId={selected.id}
          kind={selected.kind}
          data={selected.data}
          onClose={() => {
            setSetupOpen(false)
            editorStore.getState().clearFocusedField()
          }}
          webhook={webhook}
          outputs={mappingOutputs}
          live={live}
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
  webhook,
  outputs,
  live,
}: {
  nodeId: string
  kind: string
  data: Record<string, unknown>
  onClose: () => void
  onDelete: () => void
  webhook: WebhookInfo | null
  /** What earlier steps produced, for the mapping side. */
  outputs: Record<string, unknown>
  live: boolean
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
      <div className="dialog dialog-wide" role="dialog" aria-modal="true" aria-label={`Configure ${nodeId}`}>
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

        {/*
          One container, two panes: the fields on the left and what can go in
          them on the right. They were a dialog and a side panel before, which
          meant the thing you were filling in and the thing you were filling it
          from were separated by a backdrop.
        */}
        <div className="dialog-body split">
          <div className="split-left">
            {/* A trigger is the one step whose most useful fact is not a field:
                it is the address to send to. */}
            {kind === "trigger" && <TriggerEndpoint webhook={webhook} />}
            <StepForm key={nodeId} nodeId={nodeId} kind={kind} data={data} />
          </div>

          <div className="split-right">
            <MappingPanel
              nodeId={nodeId}
              kind={kind}
              data={data}
              outputs={outputs}
              live={live}
              editable
            />
          </div>
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
        <h2>Step</h2>
        {selected === null ? (
          <p className="muted">Select a step to see it here.</p>
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
 * One collapsible section per upstream step, each listing what that step
 * produced. Clicking a field inserts a reference into whichever setup field is
 * being edited — which is the only way to insert at all, because selecting a
 * step is for reading it and editing happens in the setup dialog.
 *
 * There is deliberately no field picker here. It used to carry its own
 * dropdown of `to / subject / body`, which meant two places decided where a
 * click would land and they could disagree. The setup dialog is the one place
 * that decides now.
 *
 * Only *ancestors* are offered. Listing every step would invite exactly the
 * mapping the validation then rejects, which is a poor way to learn a rule.
 */
function MappingPanel({
  nodeId,
  kind,
  data,
  outputs: allOutputs,
  live,
  editable,
}: {
  nodeId: string
  kind: string
  data: Record<string, unknown>
  outputs: Record<string, unknown>
  live: boolean
  editable: boolean
}) {
  const nodes = useStore(graphStore, (state) => state.nodes)
  const edges = useStore(graphStore, (state) => state.edges)
  const focusedField = useStore(editorStore, (state) => state.focusedField)
  const fields = SCHEMAS[kind]?.fields ?? []

  /** Which sections are open. Several at once, because comparing two steps'
   *  output is a normal thing to want and an accordion that closes the last
   *  one makes that impossible. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  const available = useMemo(() => {
    const upstream = ancestors({ nodes, edges }, nodeId)
    const outputs: Record<string, unknown> = {}
    for (const id of upstream) {
      if (allOutputs[id] !== undefined) outputs[id] = allOutputs[id]
    }
    return outputs
  }, [nodes, edges, nodeId, allOutputs])

  /**
   * The upstream steps, in flow order, with whatever each produced.
   *
   * Steps with no recorded output are kept in the list rather than dropped.
   * Omitting them implies they produce nothing; the truth is they have not run
   * yet, which is fixable by running the flow — and a list that silently omits
   * half the flow is one nobody can trust.
   */
  const sections = useMemo(() => {
    const upstream = ancestors({ nodes, edges }, nodeId)
    return nodes
      .filter((node) => upstream.has(node.id))
      .map((node) => {
        const output = allOutputs[node.id]
        const leaves =
          output === undefined
            ? []
            : outputTree({ [node.id]: output } as Record<string, { output: unknown }>).filter(
                // The step's own root row is redundant inside its own section.
                (leaf) => leaf.path !== node.id,
              )
        return {
          id: node.id,
          label: String(node.data?.label ?? node.id),
          hasOutput: output !== undefined,
          leaves,
        }
      })
  }, [nodes, edges, nodeId, allOutputs])

  /** The setup field a click fills in. Only the dialog sets this. */
  const target = focusedField?.nodeId === nodeId ? focusedField.field : ''
  const targetValue = String(data[target] ?? '')

  const preview = useMemo(
    () => resolveTemplate(targetValue, available),
    [targetValue, available],
  )

  const insert = useCallback(
    (path: string) => {
      // Belt as well as braces: the buttons are disabled without a target, but
      // a panel that can write to a step while no dialog is open is a bug this
      // has had before, and it should not rest on a `disabled` attribute.
      if (!editable || target === '') return
      const next = `${targetValue}${targetValue.length > 0 ? ' ' : ''}${referenceFor(path)}`
      graphStore.getState().updateNodeData(nodeId, { [target]: next })
      graphStore.endGesture()
    },
    [editable, target, targetValue, nodeId],
  )

  const toggle = (id: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (fields.length === 0) {
    return <p className="muted">This step has no fields to map into.</p>
  }

  return (
    <>
      {target === '' ? (
        <p className="muted tree-readonly">
          {editable
            ? 'Click a field in the setup dialog, then pick a value below to fill it in.'
            : 'Looking, not editing. Double-click the step — or press Setup… — to insert any of these.'}
        </p>
      ) : (
        <>
          <p className="muted target-note">
            filling in <span className="field-locked">{target}</span>
          </p>

          <div className="preview">
            <span className="preview-label">preview</span>
            {targetValue === '' ? (
              <em className="muted">empty</em>
            ) : preview.missing.length > 0 ? (
              <span
                className="preview-missing"
                title={`Unresolved: ${preview.missing.join(', ')}`}
              >
                {preview.text}
              </span>
            ) : (
              <span className="preview-value">{preview.text}</span>
            )}
          </div>
        </>
      )}

      <h2 className="tree-heading">
        Available from earlier steps
        <span className="tree-source muted">{live ? 'from the last run' : 'sample data'}</span>
      </h2>

      {sections.length === 0 ? (
        <p className="muted">
          Nothing runs before this step yet. Connect it to something upstream first.
        </p>
      ) : (
        <ul className="sources">
          {sections.map((section) => {
            const isOpen = open.has(section.id)
            return (
              <li key={section.id}>
                <button
                  className="source-head"
                  onClick={() => toggle(section.id)}
                  aria-expanded={isOpen}
                  disabled={!section.hasOutput}
                  title={
                    section.hasOutput
                      ? `${isOpen ? 'Hide' : 'Show'} what ${section.label} produced`
                      : `${section.label} has not run yet`
                  }
                >
                  <span className="source-caret" aria-hidden="true">
                    {section.hasOutput ? (isOpen ? '▾' : '▸') : '·'}
                  </span>
                  <span className="source-name">{section.label}</span>
                  <span className="source-count muted">
                    {section.hasOutput ? section.leaves.length : 'not run yet'}
                  </span>
                </button>

                {isOpen && (
                  <ul className="tree">
                    {section.leaves.map((leaf) => {
                      const container = leaf.kind === 'object' || leaf.kind === 'array'
                      return (
                        <li key={leaf.path}>
                          <button
                            className="pill"
                            onClick={() => insert(leaf.path)}
                            disabled={!editable || target === '' || container}
                            title={
                              container
                                ? 'Pick a field inside this'
                                : target === ''
                                  ? `${referenceFor(leaf.path)} — click a setup field first`
                                  : `Insert ${referenceFor(leaf.path)} into ${target}`
                            }
                          >
                            {/* The dotted path rather than an indent. Indenting
                                shifted the text of every row by its depth, so
                                the names never lined up even though their
                                columns did — and the path says where a field
                                sits more precisely than an indent ever could. */}
                            <span className="pill-key">
                              {leaf.path.slice(section.id.length + 1).replace(/^output\./, '')}
                            </span>
                            <span className={`pill-kind kind-${leaf.kind}`}>{leaf.kind}</span>
                            {!container && (
                              <span className="pill-value">{String(leaf.value)}</span>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
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
  const schema = SCHEMAS[kind]
  const fields = schema?.fields ?? []

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
          multiline={schema?.multiline?.includes(field) ?? false}
          nodeId={nodeId}
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
  multiline = false,
  nodeId,
  onCommit,
}: {
  label: string
  value: string
  multiline?: boolean
  /** Set only inside the setup dialog, where a mapping click can target it. */
  nodeId?: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = () => draft !== value && onCommit(draft)

  // Announce which field the mapping panel should insert into. Not cleared on
  // blur: clicking the panel blurs this input first, and clearing here would
  // forget the target before the click landed.
  const claimFocus = () => {
    if (nodeId !== undefined) editorStore.getState().focusField(nodeId, label)
  }

  // Enter blurs a single-line field, which is how you commit it. In a textarea
  // Enter is a newline — an email body without paragraphs is not a body — so
  // only Escape is bound there, and blur does the committing.
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      setDraft(value)
      return
    }
    if (event.key === 'Enter' && !multiline) event.currentTarget.blur()
  }

  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={draft}
          rows={5}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onFocus={claimFocus}
          onKeyDown={onKeyDown}
          placeholder="Hi {{ steps.fetch.output.name }},…"
        />
      ) : (
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onFocus={claimFocus}
          onKeyDown={onKeyDown}
          placeholder={label === 'url' ? 'https://…  or  {{ steps.x.output.url }}' : ''}
        />
      )}
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
