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
  ViewportPortal,
  useStore as useFlowStore,
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
import {
  ancestors,
  canConnect,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from './core/graph.ts'
import { canPublish, issuesByNode, validate } from './core/validation.ts'
import { createAutosave, type SaveState } from './core/patch.ts'
import { outputTree, referenceFor, resolveTemplate } from './core/resolve.ts'
import { buildRunView, outputsFromRun, summarise, type RunRecord } from './core/run.ts'
import { describeRun, relativeTime, sortHistory, type RunListing } from './core/history.ts'
import { diffGraph } from './core/patch.ts'
import { apiFetch, writeApiKey, UnauthorizedError } from './core/api.ts'
import {
  applyTheme,
  nextTheme,
  readTheme,
  themeGlyph,
  themeLabel,
  type Theme,
} from './core/theme.ts'
import { KIND_ACCENT, nodeTypes } from './components/StepNode.tsx'
import { edgeTypes } from './components/CuttableEdge.tsx'
import { EMPTY_FLOW, SAMPLE_FLOW, SAMPLE_OUTPUTS, SAMPLE_RUN, STEP_KINDS, SCHEMAS } from './sample.ts'
import './app.css'

/**
 * A step card's size, for the places that need it before one exists.
 *
 * Taken from `.step-node` in the stylesheet: 13rem wide at the default root
 * size, and about two lines of padding tall. It is only ever used to *place*
 * something — nothing is sized from it — so being a few pixels out nudges a
 * node rather than drawing it wrong. Where a card already exists on screen its
 * measured size is used instead, and these are the fallback.
 */
const NODE_WIDTH = 208
const NODE_HEIGHT = 44

/** The space between a step and the ghost of the next one. */
const APPEND_GAP = 56

/**
 * How an edge the run did not take is drawn.
 *
 * At module scope so every dimmed edge shares one object. A literal here would
 * be a new reference on each recompute, which defeats the edge component's
 * `memo` for a value that never actually changes.
 */
const DIMMED_EDGE = { opacity: 0.22, strokeDasharray: '4 4' } as const

/** Joins the parts of a cache signature; not something a value contains. */
const SEPARATOR = '\u0001'

const graphStore = createGraphStore({ initial: SAMPLE_FLOW })
const editorStore = createEditorStore()

/** Line breaks for window.confirm, which takes plain text. */
const CONFIRM_NEWLINE = String.fromCharCode(10)

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
  readonly published: boolean
  readonly publishedAt: string | null
  readonly runCount: number
  readonly lastRunAt: string | null
  readonly lastRunStatus: string | null
}

export interface WebhookInfo {
  readonly url: string
  readonly endpointId: string
  readonly scheme: string
  readonly signatureHeader: string
  readonly secretConfigured: boolean
}

/**
 * Naming a new flow.
 *
 * A dialog rather than window.prompt. The prompt could not say what a flow
 * gets when it is created — its own webhook address, in a scheme that has to
 * match whoever will be sending to it — and offered no way to choose the
 * scheme at all, so every flow was a Stripe one whether or not that was true.
 */
function NewFlowDialog({
  onClose,
  onCreate,
}: {
  readonly onClose: () => void
  readonly onCreate: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed === '' || busy) return
    setBusy(true)
    setError(null)
    onCreate(trimmed).catch((problem: unknown) => {
      setError(problem instanceof Error ? problem.message : String(problem))
      setBusy(false)
    })
  }

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
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="New flow">
        <header className="dialog-header">
          <div>
            <strong>New flow</strong>
          </div>
          <button className="dismiss" onClick={onClose} aria-label="Close" title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span>name</span>
            <input
              value={name}
              autoFocus
              placeholder="Order notifications"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit()
              }}
            />
          </label>

          {/*
            The signature scheme used to be asked here, and it should not have
            been. Creating a flow is the moment someone knows least about it —
            least of all which of four signing conventions the thing that has
            not been connected yet will use. It made naming a flow wait behind
            a cryptography question, and the honest hint underneath admitted
            the failure mode was opaque.

            The flow now takes the server's configured scheme, and the trigger
            panel shows which one it got along with the header it expects. That
            is where someone is already looking when they wire up a sender, and
            it is the only point at which the answer is knowable.
          */}
          <p className="muted endpoint-hint">
            You&rsquo;ll get a webhook address for this flow straight away. Open
            the trigger to see it, along with how deliveries to it are signed.
          </p>

          <p className="muted endpoint-hint">
            The flow gets its own webhook address, using the server&rsquo;s{' '}
            <code>WEBHOOK_SECRETS</code>. You can see the address on its trigger
            once it is created.
          </p>

          {error !== null && <p className="endpoint-warn">{error}</p>}
        </div>

        <footer className="dialog-footer">
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="publish" onClick={submit} disabled={name.trim() === '' || busy}>
            {busy ? 'Creating…' : 'Create flow'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * The overview: every flow, and a way into one.
 *
 * The editor used to be the whole application, with a dropdown in its header
 * for changing which flow it was editing. That made the flow list a detail of
 * the editor rather than the thing you actually arrive at, and gave no way to
 * be looking at nothing in particular — which is exactly where you are before
 * you have decided what to work on.
 *
 * Each card says the two things that decide whether a flow needs attention:
 * whether it has ever been published, and when it last ran.
 */
function Overview({
  flows,
  onOpen,
  onCreate,
  onArchive,
  connected,
  now,
}: {
  readonly flows: readonly FlowSummary[]
  readonly onOpen: (flowId: string) => void
  readonly onCreate: () => void
  readonly onArchive: (flow: FlowSummary) => void
  readonly connected: boolean
  readonly now: number
}) {
  return (
    <div className="overview">
      <header className="overview-head">
        <div>
          <h1>Flows</h1>
          <p className="muted">
            {connected
              ? `${flows.length} flow${flows.length === 1 ? '' : 's'} on this server`
              : 'No server connected — start the AutomaBuild server to see your flows'}
          </p>
        </div>
        <button className="publish" onClick={onCreate} disabled={!connected}>
          New flow
        </button>
      </header>

      {flows.length === 0 ? (
        <p className="muted overview-empty">
          {connected
            ? 'Nothing here yet. Create a flow and it will get its own webhook address.'
            : 'Nothing to show without a server.'}
        </p>
      ) : (
        <ul className="flow-grid">
          {flows.map((flow) => (
            <li key={flow.flowId}>
              {/* The card is the button. A card with a separate "open" control
                  makes people hunt for the control, and the whole card is the
                  target they were already aiming at. */}
              <button className="flow-card" onClick={() => onOpen(flow.flowId)}>
                <span className="flow-card-top">
                  <span className="flow-card-name">{flow.name}</span>
                  {flow.isDefault && <span className="tag">default</span>}
                </span>

                <span className="flow-card-meta muted">
                  {flow.published ? (
                    <span className="flow-live">● published</span>
                  ) : (
                    <span className="flow-draft">○ never published</span>
                  )}
                  {flow.scheme !== null && <span>· {flow.scheme}</span>}
                </span>

                <span className="flow-card-runs muted">
                  {flow.runCount === 0
                    ? 'no runs yet'
                    : `${flow.runCount} run${flow.runCount === 1 ? '' : 's'}`}
                  {flow.lastRunAt !== null && (
                    <>
                      {' · last '}
                      <span className={`status-${flow.lastRunStatus ?? 'unknown'}`}>
                        {flow.lastRunStatus}
                      </span>
                      {` ${relativeTime(flow.lastRunAt, now)}`}
                    </>
                  )}
                </span>
              </button>

              {/* Outside the card, so clicking the card can never archive. */}
              <button
                className="flow-card-archive"
                disabled={flow.isDefault}
                title={
                  flow.isDefault
                    ? 'The default flow cannot be archived — the server recreates it on every start'
                    : `Archive ${flow.name}`
                }
                aria-label={`Archive ${flow.name}`}
                onClick={() => onArchive(flow)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
  onDragKind,
}: {
  readonly onAdd: (kind: string) => void
  /**
   * Which kind is being dragged, or null when nothing is.
   *
   * The canvas needs this to know whether to offer anywhere to drop. It cannot
   * work it out for itself: the payload of a drag is only readable in `drop`,
   * not in `dragover`, so by the time the canvas can see what is being carried
   * the gesture is already over.
   */
  readonly onDragKind: (kind: string | null) => void
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
                onDragKind(kind)
              }}
              // Fires whether the drag was dropped or abandoned, which is the
              // only event that does both. Without it, releasing over the
              // library would leave the hint on screen for good.
              onDragEnd={() => onDragKind(null)}
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

/**
 * A graph reference that changes only when validation would notice.
 *
 * Positions are excluded deliberately: nothing `validate` looks at depends on
 * where a node sits, so a drag must not invalidate its result.
 */
function useValidationGraph(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
): FlowGraph {
  const held = useRef<{ readonly key: readonly unknown[]; readonly graph: FlowGraph } | null>(null)

  const key: unknown[] = []
  for (const node of nodes) key.push(node.id, node.kind, node.data)
  key.push(SEPARATOR)
  for (const edge of edges) key.push(edge.id, edge.source, edge.target, edge.sourceHandle)

  const previous = held.current
  const unchanged =
    previous !== null &&
    previous.key.length === key.length &&
    previous.key.every((value, index) => Object.is(value, key[index]))

  if (!unchanged) held.current = { key, graph: { nodes: [...nodes], edges: [...edges] } }
  return held.current!.graph
}

function Editor() {
  const nodes = useStore(graphStore, (state) => state.nodes)
  const edges = useStore(graphStore, (state) => state.edges)
  const selectedNodeId = useStore(editorStore, (state) => state.selectedNodeId)
  const mode = useStore(editorStore, (state) => state.mode)
  const leftPanelOpen = useStore(editorStore, (state) => state.leftPanelOpen)

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
  const [theme, setTheme] = useState<Theme>(() => readTheme())

  // Applied as an effect rather than during render, because it touches the
  // document: a render that mutates the DOM outside React is one React may run
  // twice in development and then disagree with.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

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
  const [newFlowOpen, setNewFlowOpen] = useState(false)

  /** Whether a step is being dragged over the append hint. */
  const [dropHint, setDropHint] = useState(false)

  /**
   * Which connections are selected.
   *
   * Tracked because the graph is controlled: React Flow reports a selection
   * change and it is this component's job to remember it. Without that, Delete
   * worked on a step and did nothing at all on a connection, and the only way
   * to remove one was to find its scissors with the mouse — an asymmetry with
   * no reason behind it.
   */
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set())

  /**
   * The kind currently being dragged out of the library, if any.
   *
   * The hint used to sit on the canvas permanently, which made it a piece of
   * furniture rather than an offer — something always there to be ignored,
   * and one more box to read past when looking at the flow itself. It now
   * appears for the length of a drag and then goes.
   */
  const [dragKind, setDragKind] = useState<string | null>(null)

  // The autosave closure is built once and outlives every flow switch, so it
  // reads the current flow through a ref. Capturing flowId directly would have
  // it writing this flow's draft under the id of whichever flow was open when
  // the editor started.
  const flowRef = useRef<string | null>(null)

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

  /*
    The same graph, but only a new object when validation would say something
    different about it.

    `graph` above changes on every pointer-move of a drag, because the store
    hands back a new nodes array each tick. Validation does not read positions
    at all — it reads kinds, configured data and edges — so deriving `issues`
    from `graph` re-ran an O(N * (N+E)) pass sixty times a second to produce
    the identical answer, and the result fed `byNode`, which fed every node's
    props.

    The fingerprint is O(N+E) and compares the pieces validation actually
    consults. `data` is compared by reference, which is sound because the
    store replaces a node object on a move but carries its `data` across
    untouched.
  */
  const validationGraph = useValidationGraph(nodes, edges)

  // Validation is derived, not stored. Storing it would mean keeping it in
  // sync, and a stale error highlighting the wrong node is worse than none.
  const issues = useMemo(() => validate(validationGraph, { schemas: SCHEMAS }), [validationGraph])
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
  /** Everything scoped to a flow carries this. */
  const scope = flowId === null ? '' : `?flow=${encodeURIComponent(flowId)}`

  const [run, setRun] = useState<RunRecord>(SAMPLE_RUN)

  /**
   * Two different questions, which used to be one.
   *
   * `connected` is whether a server answered at all. `live` is whether *this
   * flow* has a run to show. Conflating them meant a flow that had never
   * received a webhook still displayed the bundled sample's fields — under its
   * own step ids, because a new flow's trigger is also called `trigger` — so
   * the editor offered fields that had never existed anywhere.
   */
  const [connected, setConnected] = useState(false)
  const [live, setLive] = useState(false)
  const [history, setHistory] = useState<readonly RunListing[]>([describeRun(SAMPLE_RUN)])
  const [loadingRun, setLoadingRun] = useState(false)

  // Fixed at mount, so every "4 min ago" in the list is relative to the same
  // instant. Recomputing per row would let two rows a millisecond apart
  // disagree about what "now" is.
  const renderedAt = useRef(Date.now()).current

  useEffect(() => {
    if (flowId === null) return
    let cancelled = false

    // Everything here belongs to one flow. Without this reset the previous
    // flow's run stayed on screen until the new request came back — and if the
    // new flow had never run, it stayed for good, so its fields showed up in
    // the mapping panel of a flow that had never produced them.
    setRun(SAMPLE_RUN)
    setHistory([])
    setLive(false)

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

        // An answer at all — even an empty list — means there is a server, and
        // that its answer for this flow is "nothing yet" rather than "no idea".
        setConnected(true)

        // A run without steps is not a run this viewer can render.
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
  }, [flowId, scope])


  const loadFlows = useCallback((select?: string) => {
    apiFetch('api/flows')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: FlowSummary[] | null) => {
        if (!Array.isArray(data)) return
        setFlowList(data)
        setConnected(true)

        // Nothing is opened automatically. The overview is where you arrive,
        // and picking a flow to edit is a decision rather than a default —
        // opening one on load meant there was no way to be looking at the list
        // itself. `select` is for right after creating a flow, where finding
        // the new one in the list would be a step nobody wants.
        if (select !== undefined) setFlowId(select)
        else {
          // A flow that has gone (archived elsewhere, or by us) must not stay
          // open with an id the server no longer serves.
          setFlowId((current) =>
            current !== null && data.some((flow) => flow.flowId === current) ? current : null,
          )
        }
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

    // Hand the autosave over to this flow before anything else.
    //
    // A save scheduled while the previous flow was open is still armed, and its
    // closure writes to whichever flow the ref points at — so without
    // cancelling, the outgoing flow's graph lands under the incoming flow's
    // key. Which then looks exactly like the switch not happening: the draft
    // check below finds that write and keeps the old canvas.
    autosave.cancel()
    flowRef.current = flowId

    // This flow's own draft, if it has one. Restoring here rather than in a
    // separate mount-only effect is the other half of the bug: switching flows
    // never re-read the draft, so the canvas kept whatever was already on it.
    const saved = localStorage.getItem(draftKeyFor(flowId))
    if (saved !== null) {
      try {
        const parsed = JSON.parse(saved) as FlowGraph
        graphStore.getState().replaceGraph(parsed)
        graphStore.temporal.getState().clear()
        autosave.reset(parsed)
        setRestored(true)
      } catch {
        localStorage.removeItem(draftKeyFor(flowId))
      }
    } else {
      setRestored(false)
    }

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
    // `scope` is why this list is not empty. Every other callback here reads
    // the stores imperatively through getState(), so it genuinely has no
    // dependencies; this one closes over a render value, and leaving it out
    // froze it at its mount value — the empty string, because no flow is open
    // yet when the editor first renders. Every publish for the whole session
    // then went to `api/flows/published` with no ?flow=, which the server
    // reads as the default flow. It published the right graph to the wrong
    // flow, and said 201.
  }, [scope])

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

  /**
   * Archive a flow.
   *
   * Lifted out of the toolbar so the overview can offer it too, and so both
   * places ask the same question and clean up the same draft.
   */
  const archiveFlow = useCallback(
    (flow: FlowSummary) => {
      const ok = window.confirm(
        [
          `Archive "${flow.name}"?`,
          '',
          'Its webhook address stops accepting deliveries, and the flow ' +
            'and its run history disappear from the editor.',
          '',
          'Nothing is deleted — the runs stay in the database — but ' +
            'there is no way back to them from here.',
        ].join(CONFIRM_NEWLINE),
      )
      if (!ok) return

      apiFetch(`api/flows/${encodeURIComponent(flow.flowId)}`, { method: 'DELETE' })
        .then(async (response) => {
          const data = (await response.json()) as { error?: string }
          if (!response.ok) throw new Error(data.error ?? 'could not archive the flow')
          try {
            // The flow is gone from the list; a draft left behind would come
            // back if the id ever did.
            localStorage.removeItem(draftKeyFor(flow.flowId))
          } catch {
            // Nothing to do; the draft simply outlives the flow.
          }
          setFlowId(null)
          loadFlows()
        })
        .catch((error: unknown) => {
          setPublishError(error instanceof Error ? error.message : String(error))
        })
    },
    [loadFlows],
  )

  const createFlow = useCallback(
    // No scheme. Omitting it lets the server apply the one it is configured
    // with, which is also the one every existing endpoint already uses — so a
    // flow made here can receive a delivery from the same sender as the last
    // one without anybody choosing anything.
    (name: string) =>
      apiFetch('api/flows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(async (response) => {
        const created = (await response.json()) as { flowId?: string; error?: string }
        if (!response.ok) throw new Error(created.error ?? 'could not create the flow')
        setNewFlowOpen(false)
        loadFlows(created.flowId)
      }),
    [loadFlows],
  )

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
    // `scope` for the same reason as publish, and it is not inert here either:
    // switching flows resets `run` to SAMPLE_RUN, whose id is the same
    // constant every time, so `run.id` alone can be unchanged across a switch
    // and leave this holding the previous flow's scope.
    [run.id, scope],
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
  /**
   * What the mapping panel offers.
   *
   * With a server, only what *this* flow actually produced — so a webhook
   * trigger offers the shape of the payloads it has really received, and a
   * flow that has never run offers nothing rather than another flow's fields.
   *
   * The sample is the fallback for having no server at all, which is the case
   * the editor opened from a static host is in. Merging it underneath a real
   * run was the bug: node ids are not unique across flows — every flow's
   * trigger is called `trigger` — so the sample's fields appeared under the
   * ids of steps that had never produced them.
   */
  const mappingOutputs = useMemo(() => {
    // Three cases, and the middle one is the one that was wrong.
    //
    // `run` is reset to the bundled sample when the flow changes, so the run
    // viewer has a graph to draw rather than flashing empty. That made
    // `connected ? outputsFromRun(run) : SAMPLE_OUTPUTS` derive the sample's
    // fields anyway whenever a flow had no runs — the exact leak this was
    // meant to fix, arriving by a different route. `live` is the flag that
    // says the run is a real one.
    if (!connected) return SAMPLE_OUTPUTS
    if (!live) return {}
    return outputsFromRun(run)
  }, [run, connected, live])

  const runView = useMemo(() => buildRunView(run), [run])
  const runSummary = useMemo(() => summarise(run), [run])
  const viewing = mode === 'run'


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

      // Delete and Backspace remove the selection — but never while a field
      // has focus, or backspacing a typo would delete the step.
      if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) {
        if (editorStore.getState().selectedNodeId !== null) {
          event.preventDefault()
          deleteSelected()
        } else if (selectedEdgeIds.size > 0) {
          // A step wins when both are selected: it is the larger thing, and
          // removing it takes its connections with it anyway.
          event.preventDefault()
          for (const id of selectedEdgeIds) graphStore.getState().removeEdge(id)
          graphStore.endGesture()
          setSelectedEdgeIds(new Set())
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
  }, [deleteSelected, selectedEdgeIds])

  /* ------------------------------------------------ store → React Flow */

  const rfNodeCache = useRef(
    new Map<string, { signature: string; source: FlowNode; node: Node }>(),
  )

  const rfNodes = useMemo<Node[]>(() => {
    const source = viewing ? run.graph.nodes : nodes
    const cache = rfNodeCache.current
    const fresh = new Map<string, { signature: string; source: FlowNode; node: Node }>()

    const built = source.map((node) => {
      // Not named `run`: that shadowed the run being viewed, whose graph the
      // line above reads.
      const stepRun = viewing ? runView.byNode.get(node.id) : undefined
      const nodeIssues = viewing ? [] : (byNode.get(node.id) ?? [])
      const messages = nodeIssues.map((issue) => issue.message)

      const candidate: Node = {
        id: node.id,
        type: 'step',
        position: node.position,
        selected: node.id === selectedNodeId,
        deletable: !viewing,
        draggable: !viewing,
        data: {
          ...node.data,
          kind: node.kind,
          issueCount: messages.length,
          // The messages themselves, so hovering a red step says what is wrong
          // with it. There is no list anywhere else any more.
          issues: messages,
          hasError: nodeIssues.some((issue) => issue.severity === 'error'),
          outcome: stepRun?.outcome,
          durationMs: stepRun?.durationMs,
        },
      }

      /*
        Reuse the previous object when nothing about this node changed.

        `StepNode` is memoised and compares props shallowly, so a fresh `data`
        object defeats it even when every value inside is identical. Without
        this, dragging one node re-rendered all of them on every pointer
        frame — the exact cost the store takes care to avoid by keeping
        untouched node objects reference-stable, given away again here.

        The node object itself is compared by reference (it covers position,
        kind and data), and everything derived from outside it is folded into
        a short string.
      */
      const signature = [
        candidate.selected,
        candidate.deletable,
        candidate.data.issueCount,
        candidate.data.hasError,
        messages.join(SEPARATOR),
        stepRun?.outcome ?? '',
        stepRun?.durationMs ?? '',
      ].join(SEPARATOR)

      const cached = cache.get(node.id)
      const reusable =
        cached !== undefined && cached.signature === signature && Object.is(cached.source, node)

      const resolved = reusable ? cached.node : candidate
      fresh.set(node.id, { signature, source: node, node: resolved })
      return resolved
    })

    // Replaced wholesale so a deleted node's entry cannot outlive it.
    cache.clear()
    for (const [id, entry] of fresh) cache.set(id, entry)
    return built
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
        type: 'cuttable',
        selected: selectedEdgeIds.has(edge.id),
        label: edge.sourceHandle,
        animated: viewing && taken,
        deletable: !viewing,
        // The untaken branch is dimmed rather than hidden. Hiding it would
        // remove the very thing the viewer is meant to explain: that there was
        // another path and this run did not take it.
        style: viewing && !taken ? DIMMED_EDGE : undefined,
      }
    })
  }, [edges, viewing, run, runView, selectedEdgeIds])

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

      let selection: Set<string> | null = null
      for (const change of changes) {
        if (change.type === 'remove') graphStore.getState().removeEdge(change.id)
        else if (change.type === 'select') {
          selection ??= new Set(selectedEdgeIds)
          if (change.selected) selection.add(change.id)
          else selection.delete(change.id)
        }
      }
      if (selection !== null) setSelectedEdgeIds(selection)
    },
    [viewing, selectedEdgeIds],
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

  /**
   * The last step in the chain, and where a new one would go after it.
   *
   * "Last" is the node nothing leads away from. A branch has two, so there is
   * no single place to offer — the drop hint is for the ordinary case of
   * extending a straight chain, and a branch is not that.
   */
  const tail = useMemo(() => {
    if (nodes.length === 0) return null
    const hasOutgoing = new Set(edges.map((edge) => edge.source))
    const ends = nodes.filter((node) => !hasOutgoing.has(node.id))
    if (ends.length !== 1) return null
    const node = ends[0]!
    if (node.kind === 'branch') return null
    return node
  }, [nodes, edges])

  /**
   * The tail card's rendered size.
   *
   * The hint used to be a fixed 200 by 64 next to a card that is 208 by 44, so
   * it was both too narrow and too tall — the two never lined up, and the stub
   * joining them met the card above its handle. React Flow measures every node
   * it has laid out, so the real numbers are already known and the hint can
   * simply be the same size as the thing it continues.
   *
   * Returned as text rather than an object because this selector runs on every
   * store change, and a fresh `{ width, height }` each time would compare
   * unequal to the last one and re-render forever.
   */
  const tailSize = useFlowStore(
    useCallback(
      (state: { nodeLookup: Map<string, { measured?: { width?: number; height?: number } }> }) => {
        if (tail === null) return ''
        const measured = state.nodeLookup.get(tail.id)?.measured
        if (measured?.width === undefined || measured.height === undefined) return ''
        return `${measured.width}x${measured.height}`
      },
      [tail],
    ),
  )

  /** The slot the next step would occupy: the hint draws it, and a drop fills it. */
  const appendSlot = useMemo(() => {
    if (tail === null) return null
    const [w, h] = tailSize === '' ? [NODE_WIDTH, NODE_HEIGHT] : tailSize.split('x').map(Number)
    const width = w ?? NODE_WIDTH
    const height = h ?? NODE_HEIGHT
    return { x: tail.position.x + width + APPEND_GAP, y: tail.position.y, width, height }
  }, [tail, tailSize])

  const addStep = useCallback((kind: string, position?: { x: number; y: number }) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 7)}`
    graphStore.getState().addNode({
      id,
      kind,
      position: position ?? { x: 120 + Math.random() * 320, y: 80 + Math.random() * 260 },
      data: { label: kind },
    })
    editorStore.getState().select(id)
    return id
  }, [])

  // Dropping onto the canvas needs the pointer translated out of screen space
  // and into flow space, otherwise the node lands wherever the viewport
  // happens to be panned to rather than under the cursor.
  /**
   * Add a step and join it to the end of the chain.
   *
   * Dropping onto the hint means "carry on from here", so the connection is
   * the point rather than a follow-up chore. Dropping anywhere else still
   * leaves the step unconnected, because a step dropped in open space is
   * usually one someone means to wire up themselves.
   */
  const appendStep = useCallback(
    (kind: string) => {
      if (tail === null || appendSlot === null) return
      // Exactly where the ghost was drawn, so the card does not appear to jump
      // the moment it becomes real.
      const id = addStep(kind, { x: appendSlot.x, y: appendSlot.y })
      graphStore.getState().connect({ source: tail.id, target: id })
      graphStore.endGesture()
      setDragKind(null)
    },
    [tail, appendSlot, addStep],
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDropHint(false)
      if (viewing) return
      const kind = event.dataTransfer.getData('application/automabuild-step')
      // Anything else dragged in — a file, a text selection — is not ours.
      if (kind === '' || !STEP_KINDS.includes(kind as (typeof STEP_KINDS)[number])) return

      // A node's position is its top-left corner, so passing the cursor
      // straight through put the corner under the pointer and the card itself
      // down and to the right of it — far enough, at 208 by 44, to look like
      // the drop had landed somewhere else entirely. Half the card is
      // subtracted so it arrives centred on where it was let go.
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addStep(kind, { x: at.x - NODE_WIDTH / 2, y: at.y - NODE_HEIGHT / 2 })
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

  // No flow open means the overview, which is the application's front door.
  // Rendered before the editor rather than inside it: the editor's whole
  // structure — toolbar, canvas, panels — assumes a flow, and threading "there
  // is no flow" through all of it would put a null check on every branch.
  // Not `&& !viewing`: leaving a flow from History would otherwise fall through
  // to an editor with no flow behind it.
  if (flowId === null) {
    return (
      <div className="editor">
        <header className="toolbar">
          <h1 className="brand">AutomaBuild</h1>
          <div className="spacer" />
          <button
            className="theme-toggle"
            onClick={() => setTheme((current) => nextTheme(current))}
            aria-label={themeLabel(theme)}
            title={themeLabel(theme)}
          >
            {themeGlyph(theme)}
          </button>
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
                window.location.reload()
              }}
            />
          </div>
        )}

        {publishError !== null && (
          <div className="restored publish-error" role="alert">
            <span>{publishError}</span>
            <button className="dismiss" aria-label="Dismiss" onClick={() => setPublishError(null)}>
              ✕
            </button>
          </div>
        )}

        <Overview
          flows={flowList}
          connected={connected}
          now={renderedAt}
          onOpen={(id) => setFlowId(id)}
          onCreate={() => setNewFlowOpen(true)}
          onArchive={archiveFlow}
        />

        {newFlowOpen && (
          <NewFlowDialog onClose={() => setNewFlowOpen(false)} onCreate={createFlow} />
        )}
      </div>
    )
  }

  return (
    <div className="editor">
      <header className="toolbar">
        <h1 className="brand">AutomaBuild</h1>

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

        <button
          className="theme-toggle"
          onClick={() => setTheme((current) => nextTheme(current))}
          aria-label={`Theme: ${themeLabel(theme)}`}
          title={`Theme: ${themeLabel(theme)} — click to change`}
        >
          {themeGlyph(theme)}
        </button>

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

        {viewing && (
          <span className="run-summary">
            {live ? '● live' : '○ sample'} · {run.id} · {runSummary.succeeded} ok ·{' '}
            {runSummary.notReached} not reached · {runSummary.totalMs} ms
          </span>
        )}

        {/*
          Out of the flow, back to the list.

          A dropdown made the flow list a detail of the editor; an exit makes
          the list the place you came from. It carries the flow's name because
          "which flow am I in" is the question a canvas full of steps cannot
          answer on its own.
        */}
        <button
          className="exit-flow"
          onClick={() => {
            editorStore.getState().select(null)
            // Back to Builder as well as back to the list: History is a mode
            // of a flow, and arriving in it again on the next flow you open
            // would be a state you never asked for.
            editorStore.getState().setMode('edit')
            setSetupOpen(false)
            setFlowId(null)
            loadFlows()
          }}
          title="Back to all flows"
        >
          <span aria-hidden="true">✕</span>
          <span className="exit-flow-name">
            {flowList.find((flow) => flow.flowId === flowId)?.name ?? 'Flow'}
          </span>
        </button>
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
        {/*
          The collapse handle sits against the panel edge rather than in the
          header, so it points at the thing it acts on instead of being a
          symbol you have to learn. The chevron shows which way the panel will
          move, which is the one thing a reader needs from it.
        */}
        <button
          className={leftPanelOpen ? 'edge-toggle' : 'edge-toggle collapsed'}
          onClick={() => editorStore.getState().toggleLeftPanel()}
          aria-pressed={leftPanelOpen}
          aria-label={leftPanelOpen ? 'Hide the step library' : 'Show the step library'}
          title={leftPanelOpen ? 'Hide the step library' : 'Show the step library'}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M4 3v10" />
            <path d="M12 4.5 8.5 8l3.5 3.5" />
          </svg>
        </button>

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
          <StepLibrary onAdd={addStep} onDragKind={setDragKind} />
        )}

        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
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
          {/*
          Where the next step would go.

          A ghost of the card that would appear there, rather than a plus
          button: it says what will happen and where, and dropping onto it
          connects — which is the step everyone forgets after adding a node in
          open space. Hidden while reading a run, and hidden for a branch,
          which has two ends and therefore no single "next".
        */}
        {/*
          Where the next step would go, shown only while one is being carried.

          A ghost of the card that would appear there, rather than a plus
          button: it says what will happen and where, and dropping onto it
          connects — which is the step everyone forgets after adding a node in
          open space. It appears for the length of a drag and then goes, so it
          is an offer rather than a permanent piece of furniture.

          Hidden while reading a run, and hidden for a branch, which has two
          ends and therefore no single "next".
        */}
        {!viewing && dragKind !== null && appendSlot !== null && (
          <ViewportPortal>
            <div
              className={dropHint ? 'append-hint over' : 'append-hint'}
              style={
                {
                  '--x': `${appendSlot.x}px`,
                  '--y': `${appendSlot.y}px`,
                  '--w': `${appendSlot.width}px`,
                  '--h': `${appendSlot.height}px`,
                  '--gap': `${APPEND_GAP}px`,
                } as React.CSSProperties
              }
              onDragOver={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropHint(true)
              }}
              onDragLeave={() => setDropHint(false)}
              onDrop={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropHint(false)
                const kind = event.dataTransfer.getData('application/automabuild-step')
                if (kind === '' || !STEP_KINDS.includes(kind as (typeof STEP_KINDS)[number])) return
                appendStep(kind)
              }}
            >
              <span className="append-hint-plus" aria-hidden="true">
                +
              </span>
              <span className="append-hint-text">Drop to connect</span>
            </div>
          </ViewportPortal>
        )}

        <Background gap={16} />
          <Controls showInteractive={false} />
        </ReactFlow>

        {/*
          Only in History, and always there.

          Building a flow needs no side panel now: setup and mapping share one
          dialog, and a step with a problem says so by turning red. Reading a
          run is different — the input, output and error of a step have nowhere
          else to go, and that is the whole reason to open a past run.
        */}
        {viewing && (
          <aside className="panel">
            <RunPanel selectedId={selectedNodeId} run={run} live={live} />
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
          connected={connected}
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
  connected,
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
  connected: boolean
}) {
  const isTrigger = kind === 'trigger'

  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /*
    Move focus into the dialog, and put it back on the way out.

    This one opens on a double-click, so focus was left on the canvas behind
    it: a keyboard user's next Tab went into the page under the dialog, and a
    screen reader was given no sign that a modal had appeared at all. The first
    field is the useful target, and the dialog itself is the fallback for a
    step that has nothing to configure.
  */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not(.dismiss)',
    )
    ;(first ?? panel.current)?.focus()
    return () => previous?.focus()
  }, [])

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
      <div
        ref={panel}
        tabIndex={-1}
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label={`Configure ${nodeId}`}
      >
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
        {/*
          A trigger has no upstream steps, so its mapping side is always empty.
          Splitting the dialog for it would give half the width to a permanent
          "nothing runs before this step" and take that width from the one
          thing a trigger has worth reading: its address.
        */}
        <div className={isTrigger ? 'dialog-body' : 'dialog-body split'}>
          <div className={isTrigger ? undefined : 'split-left'}>
            {/* A trigger is the one step whose most useful fact is not a field:
                it is the address to send to. */}
            {isTrigger && <TriggerEndpoint webhook={webhook} />}
            <StepForm key={nodeId} nodeId={nodeId} kind={kind} data={data} />
          </div>

          {!isTrigger && (
            <div className="split-right">
              <MappingPanel
                nodeId={nodeId}
                kind={kind}
                data={data}
                outputs={outputs}
                live={live}
                connected={connected}
                editable
              />
            </div>
          )}
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
  connected,
  editable,
}: {
  nodeId: string
  kind: string
  data: Record<string, unknown>
  outputs: Record<string, unknown>
  live: boolean
  /** Whether a server answered at all, as opposed to this flow having a run. */
  connected: boolean
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
        {/* Three states, said plainly. "Sample data" while connected to a
            server was a lie: the fields were real sample values, but they
            described a flow that had never produced them. */}
        <span className="tree-source muted">
          {!connected ? 'sample data' : live ? 'from the last run' : 'no runs yet'}
        </span>
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
          display={schema?.labels?.[field] ?? field}
          value={String(data[field] ?? '')}
          multiline={schema?.multiline?.includes(field) ?? false}
          choices={schema?.choices?.[field]}
          hint={schema?.hints?.[field]}
          placeholder={schema?.placeholders?.[field]}
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
  display,
  value,
  multiline = false,
  choices,
  hint,
  placeholder,
  nodeId,
  onCommit,
}: {
  /** The config key. What gets written into the flow, and what mapping targets. */
  label: string
  /** What the key is called on screen, when that differs. */
  display?: string
  value: string
  multiline?: boolean
  /** When present, the field is a menu rather than a text box. */
  choices?: readonly string[]
  /** A line under the field saying what belongs in it. */
  hint?: string
  placeholder?: string
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
      <span>{display ?? label}</span>

      {choices !== undefined ? (
        /*
          A menu commits on change rather than on blur.

          The blur rule exists so that typing does not put every keystroke in
          the undo stack. Choosing from a menu is one act already, and waiting
          for a blur to record it means clicking elsewhere to make a choice
          stick — which nobody expects and no other menu does.

          The empty option is what "not set" looks like. Without it a method
          field would read GET before anyone chose GET, and the flow would be
          saved with a value its author never picked.
        */
        <select
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (event.target.value !== value) onCommit(event.target.value)
          }}
          onFocus={claimFocus}
        >
          <option value="">—</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : multiline ? (
        <textarea
          value={draft}
          rows={5}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onFocus={claimFocus}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? 'Hi {{ steps.fetch.output.name }},…'}
        />
      ) : (
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onFocus={claimFocus}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? ''}
        />
      )}

      {/* Under the field rather than in a tooltip: these say things that are
          otherwise only discoverable by publishing a flow and watching it
          fail, and a tooltip is only read by someone who already suspects. */}
      {hint !== undefined && <small className="field-hint muted">{hint}</small>}
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
