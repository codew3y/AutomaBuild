/**
 * The four components, joined.
 *
 * A signed webhook arrives. `automa-webhook-gate` verifies it in constant time
 * and checks it against the replay store. A genuinely new delivery starts a
 * run in `automa-durable-runner`. A worker executes the run's steps; the HTTP
 * step goes out through `automa-safe-fetch`, so a URL someone typed into the
 * editor cannot be pointed at the metadata service. The run, and every run
 * before it, is served back to `automa-flow-canvas` for its History tab.
 *
 * The joins worth reading are the three that are not obvious:
 *
 *   - `onAccepted` is the seam between the gate and the engine. It runs once
 *     per genuinely new delivery, inside the request. Everything expensive is
 *     deliberately not here: it creates the run and returns, and the worker
 *     picks it up. A sender that times out waiting for us re-delivers, and the
 *     replay store is what makes that harmless.
 *
 *   - The worker is started in this process for the demo, and that is a
 *     deployment choice rather than a design one. `startWorker` takes a pool
 *     and a flow; running it in its own process changes nothing about the
 *     code, which is the property that matters.
 *
 *   - The API returns runs in the canvas's shape rather than the engine's. The
 *     translation is in `runs.ts` and is the only place the two vocabularies
 *     meet.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import Fastify, { type FastifyInstance } from 'fastify'

import {
  PostgresReplayStore,
  createGate,
  createPool as createGatePool,
  type EndpointConfig,
} from 'automa-webhook-gate'
import { registerRawBody, registerWebhookRoute } from 'automa-webhook-gate/fastify'
import {
  createPool as createRunnerPool,
  createRun,
  getRun,
  listSteps,
  startWorker,
  withTransaction,
  installSignalHandlers,
  type FlowDefinition,
} from 'automa-durable-runner'

import { randomUUID } from 'node:crypto'

import { loadConfig, type AppConfig } from './config.ts'
import { compileFlow, type CanvasGraph } from './flow.ts'
import { FlowStore } from './flow-store.ts'
import { mappingHandlers } from './handlers.ts'
import { toViewerListing, toViewerRun, type ViewerGraph } from './runs.ts'
import { DEMO_FLOW } from './demo-flow.ts'

const here = dirname(fileURLToPath(import.meta.url))

// The engine keys runs on uuid columns, so a flow's identity has to be one.
// Fixed rather than generated: a new id per start would file every run under a
// different flow, and the history would look like it had been wiped.
const DEMO_FLOW_ID = '00000000-0000-4000-8000-00000000f100'
const DEMO_FLOW_VERSION_ID = '00000000-0000-4000-8000-00000000f101'

export interface ServerOptions {
  readonly config?: AppConfig
  readonly graph?: CanvasGraph
  /** Off in tests that only exercise the HTTP surface. */
  readonly startWorker?: boolean
}

export interface RunningServer {
  readonly app: FastifyInstance
  readonly flow: FlowDefinition
  close(): Promise<void>
}

export async function buildServer(options: ServerOptions = {}): Promise<RunningServer> {
  const config = options.config ?? loadConfig()
  const graph = options.graph ?? DEMO_FLOW

  // Compiled before anything is served. A flow that cannot run is a
  // deployment that should not come up — discovering it when the first webhook
  // arrives means the delivery is already recorded as seen.
  const compiled = compileFlow(graph, { flowId: DEMO_FLOW_ID, versionId: DEMO_FLOW_VERSION_ID })
  if (!compiled.ok) {
    throw new Error(
      `The flow does not compile:\n${compiled.problems.map((p) => `  - ${p.message}`).join('\n')}`,
    )
  }
  for (const warning of compiled.warnings) {
    console.warn(`warning: ${warning.message}`)
  }

  const gatePool = createGatePool(config.gateDb)
  const runnerPool = createRunnerPool(config.runnerDb)

  const flows = new FlowStore({
    pool: runnerPool,
    tenantId: config.tenantId,
    flowId: DEMO_FLOW_ID,
  })

  // Seed the first version if nothing has ever been published, so a fresh
  // database has something to run rather than rejecting the first webhook.
  let current = await flows.current()
  if (current === null) {
    const seeded = await flows.publish(graph, {
      versionId: DEMO_FLOW_VERSION_ID,
      publishedBy: 'startup',
    })
    if (!seeded.ok) throw new Error('the built-in flow does not compile')
    current = seeded.published
    console.log(`seeded flow version ${current.versionId}`)
  } else {
    console.log(`current flow version ${current.versionId}`)
  }

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 })

  // Called directly on the instance the routes live on. Registering it as a
  // plugin puts the content-type parser in a child scope where the routes
  // cannot see it, and every webhook comes back 415 as if the sender were at
  // fault. The library's own comment says so; this is the caller honouring it.
  registerRawBody(app)

  const store = new PostgresReplayStore(gatePool)
  const gate = createGate({ store })

  const endpoint: EndpointConfig = {
    endpointId: config.endpointId,
    scheme: config.scheme,
    secrets: config.secrets,
  }

  registerWebhookRoute(app, {
    path: '/webhooks/:endpointId',
    gate,
    // The gate writes its record before handing off, so a handoff that throws
    // would leave the delivery recorded as seen and never acted on. Passing the
    // store lets the route unwind that record and the retry be treated as new.
    store,
    lookup: (endpointId) => (endpointId === config.endpointId ? endpoint : null),

    // The seam. Verified, de-duplicated, and now durable.
    onAccepted: async (_endpoint, request, result) => {
      const body = parseBody(request.rawBody)

      // Read per delivery, not captured once. A publish between two webhooks
      // must affect the second one, and a run created from a stale definition
      // would then be executed against a version it was not built from.
      const live = await flows.current()
      if (live === null) throw new Error('no flow is published')
      const definition = await flows.resolver()(live.versionId)
      if (definition === null) throw new Error(`flow version ${live.versionId} will not compile`)

      await withTransaction(runnerPool, async (tx) => {
        const { run, deduplicated } = await createRun(tx, {
          tenantId: config.tenantId,
          flow: definition,
          input: body,
          // The gate's dedup key, reused as the engine's. Two layers keyed on
          // the same thing is not redundant, but not for the reason first
          // written here: the gate releasing its record on a failed handoff is
          // what stops the delivery being lost, and this is what stops the
          // retry — or a replay arriving in the gap the release opens — from
          // starting a second run. createRun on this key is idempotent, so the
          // two together converge on exactly one run however the race lands.
          idempotencyKey: result.dedupKey,
        })

        if (deduplicated) {
          console.log(`delivery ${result.dedupKey} already had run ${run.id}`)
        } else {
          console.log(`delivery ${result.dedupKey} started run ${run.id}`)
        }
      })
    },
  })

  registerApi(app, runnerPool, flows, config)
  await registerCanvas(app, config)

  const worker =
    options.startWorker === false
      ? null
      : startWorker(
          runnerPool,
          {
            // A resolver, not a definition. This is what makes publishing
            // non-blocking: a run already in flight keeps resolving the version
            // it started on while new runs get the new one.
            flows: flows.resolver(),
            handlers: mappingHandlers(),
            workerId: `web-${process.pid}`,
          },
          { tenantId: config.tenantId },
        )

  const uninstall = worker === null ? () => {} : installSignalHandlers(worker)

  return {
    app,
    flow: compiled.flow,
    async close() {
      uninstall()
      if (worker !== null) await worker.stop('shutdown')
      await app.close()
      await Promise.all([gatePool.end(), runnerPool.end()])
    },
  }
}

/**
 * The webhook body, parsed if it is JSON and kept as text if it is not.
 *
 * Parsing is done here rather than by Fastify because the gate needs the exact
 * bytes to verify a signature over, and a re-serialised object is not those
 * bytes. A body that is not JSON is not an error — Slack sends form-encoded
 * payloads — so it is passed through as a string for the flow to deal with.
 */
function parseBody(raw: Buffer | undefined): unknown {
  if (raw === undefined) return null
  const text = raw.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The canvas's graph, minus anything the viewer does not read. */
function viewerGraph(graph: CanvasGraph): ViewerGraph {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      position: node.position,
      ...(node.data === undefined ? {} : { data: node.data }),
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
    })),
  }
}

function registerApi(
  app: FastifyInstance,
  pool: ReturnType<typeof createRunnerPool>,
  flows: FlowStore,
  config: AppConfig,
): void {
  app.get('/api/health', async () => ({ ok: true }))

  /**
   * What is live right now.
   *
   * The editor needs this to tell whether its draft has diverged from what is
   * running — which is the whole basis of the Publish / Discard pair. Without
   * it the editor can only ever say "unsaved", never "unpublished".
   */
  app.get('/api/flows/published', async (_request, reply) => {
    const current = await flows.current()
    if (current === null) return reply.code(404).send({ error: 'nothing published yet' })
    return {
      versionId: current.versionId,
      flowId: current.flowId,
      publishedAt: current.publishedAt.toISOString(),
      publishedBy: current.publishedBy,
      graph: current.graph,
    }
  })

  /**
   * Publish a new version.
   *
   * Always an insert, never an update. A run records the version it started on
   * and the worker resolves by that id, so overwriting would rewrite history
   * under a run still using it.
   *
   * A graph that does not compile is a 422 carrying every problem, not the
   * first one: whoever pressed the button is looking at the editor and wants
   * the list.
   */
  app.post('/api/flows/published', async (request, reply) => {
    const body = request.body as { graph?: CanvasGraph; publishedBy?: string } | undefined
    const graph = body?.graph

    if (graph === undefined || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      return reply.code(400).send({ error: 'a graph with nodes and edges is required' })
    }

    const result = await flows.publish(graph, {
      versionId: randomUUID(),
      ...(body?.publishedBy === undefined ? {} : { publishedBy: body.publishedBy }),
    })

    if (!result.ok) {
      return reply.code(422).send({
        error: 'the flow does not compile',
        problems: result.problems,
      })
    }

    console.log(`published flow version ${result.published.versionId}`)
    return reply.code(201).send({
      versionId: result.published.versionId,
      publishedAt: result.published.publishedAt.toISOString(),
    })
  })

  /**
   * The run list.
   *
   * One query against `runs`, and deliberately no join to the steps: the
   * listing exists so that a history of ten thousand runs stays a cheap query,
   * and joining here would defeat the entire reason it is a separate shape.
   * `totalMs` is summed from the run's own timestamps rather than its steps
   * for the same reason.
   */
  app.get('/api/runs', async (request) => {
    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 50), 200)
    const { rows } = await pool.query(
      `SELECT id, tenant_id, flow_id, flow_version_id, status, attempt_group,
              started_at, finished_at, deadline_at, cancel_requested_at,
              cancelled_at_step_id, step_count, steps_succeeded, steps_failed,
              error_class, error_code, input_inline,
              COALESCE((EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::integer, 0) AS total_ms
         FROM runs
        WHERE tenant_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [config.tenantId, limit],
    )

    return rows.map((row) =>
      toViewerListing(
        {
          id: row.id,
          tenantId: row.tenant_id,
          flowId: row.flow_id,
          flowVersionId: row.flow_version_id,
          status: row.status,
          attemptGroup: row.attempt_group,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          deadlineAt: row.deadline_at,
          cancelRequestedAt: row.cancel_requested_at,
          cancelledAtStepId: row.cancelled_at_step_id,
          stepCount: row.step_count,
          stepsSucceeded: row.steps_succeeded,
          stepsFailed: row.steps_failed,
          errorClass: row.error_class,
          errorCode: row.error_code,
          input: row.input_inline,
        },
        row.total_ms,
      ),
    )
  })

  app.get('/api/runs/latest', async (_request, reply) => {
    const { rows } = await pool.query(
      `SELECT id, started_at FROM runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [config.tenantId],
    )
    if (rows.length === 0) {
      // Not an error, and not an empty run either: there is genuinely nothing
      // to show, and the canvas falls back to its bundled sample. A 200 with a
      // null run would make the viewer render an empty canvas instead.
      return reply.code(404).send({ error: 'no runs yet' })
    }
    return sendRun(reply, pool, flows, rows[0].started_at, rows[0].id)
  })

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    // A run is keyed by (started_at, id) because `runs` is partitioned by
    // start time, so the timestamp has to be found before the row can be.
    const { rows } = await pool.query(
      `SELECT started_at FROM runs WHERE id = $1 AND tenant_id = $2`,
      [id, config.tenantId],
    )
    if (rows.length === 0) return reply.code(404).send({ error: 'no such run' })
    return sendRun(reply, pool, flows, rows[0].started_at, id)
  })
}

interface Replier {
  code(status: number): { send(body: unknown): unknown }
}

async function sendRun(
  reply: Replier,
  pool: ReturnType<typeof createRunnerPool>,
  flows: FlowStore,
  startedAt: Date,
  id: string,
): Promise<unknown> {
  const run = await withTransaction(pool, (tx) => getRun(tx, startedAt, id))
  if (run === null) return reply.code(404).send({ error: 'no such run' })
  const steps = await withTransaction(pool, (tx) => listSteps(tx, run))

  // The graph the run actually ran on, not whatever is live now. Drawing
  // yesterday's failure on today's diagram is the thing the run viewer exists
  // to avoid — the step being looked for may not be in the current version.
  const version = await flows.byVersion(run.flowVersionId)
  const graph: ViewerGraph =
    version === null ? { nodes: [], edges: [] } : viewerGraph(version.graph)

  return toViewerRun(run, steps, graph)
}

/**
 * Serve the built canvas.
 *
 * Hand-rolled rather than pulling in a static-file plugin, because the whole
 * requirement is four content types and one fallback, and the path handling is
 * the only part that has to be right. `resolve` then a prefix check is what
 * makes `../` in a URL a 404 rather than a way to read the server's own files.
 */
async function registerCanvas(app: FastifyInstance, config: AppConfig): Promise<void> {
  const root = resolve(here, '..', config.canvasDir)

  if (!existsSync(root)) {
    console.warn(
      `The canvas is not built. Expected ${root}.\n` +
        `Run \`npm run build\` in automa-flow-canvas, or set CANVAS_DIR.\n` +
        `The API still works; only the UI is missing.`,
    )
    return
  }

  const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }

  app.get('/*', async (request, reply) => {
    const requested = (request.params as { '*': string })['*']
    const relative = normalize(requested === '' ? 'index.html' : requested)
    const target = resolve(root, relative)

    // Anything that escapes the root is a 404, not a 403: telling a caller
    // that a path exists but is forbidden is more than they need to know.
    if (target !== root && !target.startsWith(root + sep)) {
      return reply.code(404).send({ error: 'not found' })
    }

    try {
      const body = await readFile(target)
      return reply.type(TYPES[extname(target)] ?? 'application/octet-stream').send(body)
    } catch {
      // Single-page app: an unknown path is a client-side route, so index.html
      // is the right answer rather than a 404.
      const index = await readFile(join(root, 'index.html'))
      return reply.type('text/html; charset=utf-8').send(index)
    }
  })
}

if (process.argv[1]?.endsWith('server.ts')) {
  const config = loadConfig()
  buildServer({ config })
    .then(async (server) => {
      await server.app.listen({ port: config.port, host: '0.0.0.0' })
      console.log(`\n  AutomaBuild is running.`)
      console.log(`    UI       http://localhost:${config.port}/`)
      console.log(`    webhook  POST http://localhost:${config.port}/webhooks/${config.endpointId}`)
      console.log(`    runs     http://localhost:${config.port}/api/runs\n`)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}
