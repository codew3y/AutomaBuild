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

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'

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
  type WorkerEvent,
} from 'automa-durable-runner'

import { randomUUID } from 'node:crypto'

import { loadConfig, type AppConfig } from './config.ts'
import { registerApiAuth, resolveApiKey } from './auth.ts'
import { compileFlow, type CanvasGraph } from './flow.ts'
import { FlowStore, type FlowRef } from './flow-store.ts'
import { EndpointStore, type Endpoint } from './endpoint-store.ts'
import { resolveSecrets } from './secret-source.ts'
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

  const flows = new FlowStore({ pool: runnerPool })
  const endpoints = new EndpointStore(runnerPool)

  // The endpoint in the environment is a *seed*, not the only one. It exists so
  // a fresh database has something to receive a webhook on; every other
  // endpoint is a row, and every row names its own tenant.
  const seedEndpoint = await endpoints.ensure({
    endpointId: config.endpointId,
    tenantId: config.tenantId,
    flowId: DEMO_FLOW_ID,
    scheme: config.scheme,
    // A reference, not the value. The database records where the secret lives
    // rather than what it is, so a backup, a replica or a careless SELECT *
    // does not carry a live credential.
    secretRefs: ['env:WEBHOOK_SECRETS'],
  })

  // One broken reference among several is survivable — the others still verify
  // — but it must not be silent, or a half-rotated endpoint looks healthy.
  for (const problem of seedEndpoint.secretProblems) {
    console.warn(`warning: ${problem}`)
  }

  // Move the seeded endpoint off plaintext when it is safe to do so.
  //
  // `ensure` deliberately never overwrites, because it runs on every boot and
  // would otherwise clobber a rotated secret. But an endpoint created before
  // references existed holds its secret literally, and if that value is exactly
  // what WEBHOOK_SECRETS already contains then rewriting it to a reference
  // changes nothing except that the database stops holding the credential.
  //
  // Only when the values match. Anything else is someone's deliberate
  // configuration and is left alone.
  if (
    seedEndpoint.secretSources.every((source) => source.startsWith('literal')) &&
    seedEndpoint.secrets.length === config.secrets.length &&
    seedEndpoint.secrets.every((secret, index) => secret === config.secrets[index])
  ) {
    await endpoints.setSecretRefs(seedEndpoint.endpointId, ['env:WEBHOOK_SECRETS'])
    console.log(
      `moved endpoint ${seedEndpoint.endpointId} off a plaintext secret to env:WEBHOOK_SECRETS`,
    )
  }

  const seedRef: FlowRef = { tenantId: seedEndpoint.tenantId, flowId: seedEndpoint.flowId }

  let current = await flows.current(seedRef)
  if (current === null) {
    const seeded = await flows.publish(graph, {
      ref: seedRef,
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

  // Before any route is registered, so nothing can be added later that quietly
  // sits outside the check.
  registerApiAuth(app, { apiKey: config.apiKey })

  const store = new PostgresReplayStore(gatePool)
  const gate = createGate({ store })

  registerWebhookRoute(app, {
    path: '/webhooks/:endpointId',
    gate,
    // The gate writes its record before handing off, so a handoff that throws
    // would leave the delivery recorded as seen and never acted on. Passing the
    // store lets the route unwind that record and the retry be treated as new.
    store,

    // The endpoint decides the tenant. This is the whole of what made the
    // application single-tenant: there was one id in an environment variable
    // and therefore one tenant, while every table underneath had been scoped
    // by tenant_id since the first migration.
    lookup: async (endpointId): Promise<EndpointConfig | null> => {
      const found = await endpoints.forDelivery(endpointId)
      if (found === null) return null
      return {
        endpointId: found.endpointId,
        scheme: found.scheme,
        secrets: found.secrets,
      }
    },

    // The seam. Verified, de-duplicated, and now durable.
    onAccepted: async (accepted, request, result) => {
      const body = parseBody(request.rawBody)

      // Re-read rather than trusting the gate's copy: the gate is handed only
      // what it needs to verify a signature, and the tenant is not part of
      // that.
      const owner = await endpoints.forDelivery(accepted.endpointId)
      if (owner === null) throw new Error(`endpoint ${accepted.endpointId} vanished mid-delivery`)

      const ref: FlowRef = { tenantId: owner.tenantId, flowId: owner.flowId }

      // Read per delivery, not captured once. A publish between two webhooks
      // must affect the second one, and a run created from a stale definition
      // would then be executed against a version it was not built from.
      const live = await flows.current(ref)
      if (live === null) throw new Error(`no flow is published for ${owner.flowId}`)
      const definition = await flows.resolver()(live.versionId)
      if (definition === null) throw new Error(`flow version ${live.versionId} will not compile`)

      await withTransaction(runnerPool, async (tx) => {
        const { run, deduplicated } = await createRun(tx, {
          tenantId: owner.tenantId,
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

  registerApi(app, runnerPool, flows, endpoints, seedEndpoint)
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
          {
            // No tenant filter: one worker serves every tenant, and isolation
            // is the engine's, enforced on every query rather than by which
            // process happens to be running.
            onEvent: reportWorkerEvent(),
          },
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

/** Which header each scheme signs with, so the editor can say so. */
const SIGNATURE_HEADERS: Record<string, string> = {
  stripe: 'Stripe-Signature',
  github: 'X-Hub-Signature-256',
  slack: 'X-Slack-Signature',
  standard: 'webhook-signature',
}

function registerApi(
  app: FastifyInstance,
  pool: ReturnType<typeof createRunnerPool>,
  flows: FlowStore,
  endpoints: EndpointStore,
  seed: Endpoint,
): void {
  /**
   * Which endpoint this request is about, and therefore which tenant.
   *
   * `?endpoint=` names it; the seeded one is the default so that a
   * single-tenant install needs no parameter and the editor works unchanged.
   * Everything downstream is scoped by the tenant this returns, which is what
   * stops one tenant reading another's runs — the alternative, a tenant id in
   * the query string, would be an invitation to type someone else's.
   */
  const scopeOf = async (request: FastifyRequest): Promise<Endpoint | null> => {
    const requested = (request.query as { endpoint?: string }).endpoint
    if (requested === undefined || requested === seed.endpointId) return seed
    return endpoints.byId(requested)
  }
  app.get('/api/health', async () => ({ ok: true }))

  /**
   * Where to send a webhook, and how to sign it.
   *
   * The editor could not tell anyone this before, so a trigger node was a step
   * with no address — you could build a flow and have no idea what to point at
   * it. The secret is deliberately not here: this endpoint is unauthenticated,
   * and the whole point of the secret is that possessing it proves who you are.
   */
  app.get('/api/endpoints', async () => {
    // Secrets are deliberately absent, and `secretSources` is not a leak: it
    // says *where* each secret lives, never what it is. A UI that displayed a
    // signing secret would be a UI that had been given one.
    const all = await endpoints.listForTenant(seed.tenantId)
    return all.map((endpoint) => ({
      endpointId: endpoint.endpointId,
      flowId: endpoint.flowId,
      scheme: endpoint.scheme,
      disabled: endpoint.disabledAt !== null,
      isDefault: endpoint.endpointId === seed.endpointId,
      secretSources: endpoint.secretSources,
      secretProblems: endpoint.secretProblems,
    }))
  })

  /**
   * Create an endpoint.
   *
   * Takes secret *references*, never a secret. That is the whole point of the
   * reference scheme: a create call carrying a raw secret would put it in a
   * request body, a proxy log and the database in one move, and the endpoint
   * that exists to keep credentials out of the database would be the thing
   * that put one there.
   *
   * Always in this tenant. There is no tenant parameter, because a control API
   * that lets you name the tenant is a control API that lets you name someone
   * else's.
   */
  app.post('/api/endpoints', async (request, reply) => {
    const body = request.body as
      | { scheme?: string; secretRefs?: string[]; flowId?: string }
      | undefined

    const scheme = body?.scheme ?? 'stripe'
    if (!['stripe', 'github', 'slack', 'standard'].includes(scheme)) {
      return reply.code(400).send({ error: `${scheme} is not a scheme this verifies` })
    }

    const refs = body?.secretRefs ?? []
    if (!Array.isArray(refs) || refs.length === 0) {
      return reply.code(400).send({
        error: 'secretRefs is required: where each secret lives, such as env:MY_HOOK_SECRET',
      })
    }

    const raw = refs.filter((ref) => !/^(env|file|literal):/.test(String(ref)))
    if (raw.length > 0) {
      // Refused rather than quietly stored as a literal. Accepting it would
      // make the easiest thing to type also the thing that writes a credential
      // into the database.
      return reply.code(400).send({
        error:
          'each secret must be a reference — env:NAME or file:/path. ' +
          'To store a value in the database anyway, write it as literal:VALUE and know that it is plaintext.',
      })
    }

    // Resolved before anything is written. `ensure` inserts and then reads the
    // row back, so a reference that cannot be resolved used to leave a broken
    // endpoint behind after returning 400 — a row that rejects every delivery
    // and that nobody knows exists.
    try {
      resolveSecrets(refs)
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message })
    }

    const endpointId = randomUUID()
    const flowId = body?.flowId ?? randomUUID()

    try {
      const created = await endpoints.ensure({
        endpointId,
        tenantId: seed.tenantId,
        flowId,
        scheme: scheme as Endpoint['scheme'],
        secretRefs: refs,
      })

      return reply.code(201).send({
        endpointId: created.endpointId,
        flowId: created.flowId,
        scheme: created.scheme,
        secretSources: created.secretSources,
      })
    } catch (error) {
      // The most likely failure by far: a reference to an environment variable
      // that does not exist. Reporting it as a 400 rather than a 500 is right —
      // it is the caller's input that is wrong, and the message says which.
      return reply.code(400).send({ error: (error as Error).message })
    }
  })

  app.get('/api/webhook', async (request, reply) => {
    const scope = await scopeOf(request)
    if (scope === null) return reply.code(404).send({ error: 'no such endpoint' })

    const forwardedHost = request.headers['x-forwarded-host']
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host
    const proto = request.headers['x-forwarded-proto'] ?? 'http'

    return {
      endpointId: scope.endpointId,
      scheme: scope.scheme,
      // Built from the request, so it is right behind a proxy and right when
      // the editor is being served from the dev server on another port.
      url: `${Array.isArray(proto) ? proto[0] : proto}://${host}/webhooks/${scope.endpointId}`,
      signatureHeader: SIGNATURE_HEADERS[scope.scheme],
      secretConfigured: scope.secrets.length > 0,
    }
  })

  /**
   * What is live right now.
   *
   * The editor needs this to tell whether its draft has diverged from what is
   * running — which is the whole basis of the Publish / Discard pair. Without
   * it the editor can only ever say "unsaved", never "unpublished".
   */
  app.get('/api/flows/published', async (request, reply) => {
    const scope = await scopeOf(request)
    if (scope === null) return reply.code(404).send({ error: 'no such endpoint' })

    const current = await flows.current({ tenantId: scope.tenantId, flowId: scope.flowId })
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

    const scope = await scopeOf(request)
    if (scope === null) return reply.code(404).send({ error: 'no such endpoint' })

    const result = await flows.publish(graph, {
      ref: { tenantId: scope.tenantId, flowId: scope.flowId },
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
  app.get('/api/runs', async (request, reply) => {
    const scope = await scopeOf(request)
    if (scope === null) return reply.code(404).send({ error: 'no such endpoint' })

    const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 50), 200)
    const { rows } = await pool.query(
      `SELECT id, tenant_id, flow_id, flow_version_id, status, attempt_group,
              started_at, finished_at, deadline_at, cancel_requested_at,
              cancelled_at_step_id, step_count, steps_succeeded, steps_failed,
              error_class, error_code, input_inline,
              COALESCE((EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::integer, 0) AS total_ms
         FROM runs
        WHERE tenant_id = $1 AND flow_id = $3
        ORDER BY started_at DESC
        LIMIT $2`,
      [scope.tenantId, limit, scope.flowId],
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

  app.get('/api/runs/latest', async (request, reply) => {
    const scope = await scopeOf(request)
    if (scope === null) return reply.code(404).send({ error: 'no such endpoint' })

    const { rows } = await pool.query(
      `SELECT id, started_at FROM runs WHERE tenant_id = $1 AND flow_id = $2
        ORDER BY started_at DESC LIMIT 1`,
      [scope.tenantId, scope.flowId],
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
    const scope = await scopeOf(request)
    if (scope === null) return reply.code(404).send({ error: 'no such endpoint' })

    // Scoped by tenant, and a run belonging to another one is reported as
    // absent rather than forbidden: confirming that an id exists is already
    // more than a stranger should learn.
    const { rows } = await pool.query(
      `SELECT started_at FROM runs WHERE id = $1 AND tenant_id = $2`,
      [id, scope.tenantId],
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

/**
 * Say something useful when startup fails.
 *
 * `pg` throws an AggregateError when it cannot connect, and an AggregateError
 * has an empty `message` — so printing `error.message` printed a blank line and
 * exited 1. A server that dies in silence is the worst possible failure mode:
 * there is nothing to search for and nothing to act on.
 */
/**
 * Report what the worker is doing, and above all when it fails.
 *
 * `startWorker`'s default `onEvent` is a no-op, so a worker given none fails
 * completely silently: the loop catches every error to keep itself alive, emits
 * it, and nobody is listening. The symptom is a server that answers every HTTP
 * request perfectly while no run ever leaves `running` — which is precisely
 * what happened here, and there was nothing in any log to explain it.
 *
 * Errors are collapsed while they repeat. A failing pass retries every second,
 * so printing each one buries the first occurrence — which is the one that
 * says what actually broke — under thousands of copies.
 */
function reportWorkerEvent(): (event: WorkerEvent) => void {
  let lastError: string | null = null
  let repeats = 0

  return (event: WorkerEvent) => {
    if (event.type === 'error') {
      const message = event.error.message
      if (message === lastError) {
        repeats++
        // Powers of ten, so a persistent fault stays visible without drowning
        // everything else.
        if (repeats % 100 !== 0) return
        console.error(`worker error (x${repeats}): ${message}`)
        return
      }
      lastError = message
      repeats = 1
      console.error(`worker error: ${message}`)
      if (event.error.stack !== undefined) console.error(event.error.stack)
      return
    }

    // Anything that is not an error means the loop recovered, so the next
    // failure should print in full rather than being collapsed into the last.
    lastError = null

    if (event.type === 'started') console.log(`worker ${event.workerId} started`)
    if (event.type === 'stopping') console.log(`worker stopping: ${event.reason}`)
    if (event.type === 'stopped') console.log(`worker stopped (${event.inFlight} in flight)`)
    if (event.type === 'swept' && event.rescheduled > 0) {
      console.log(`janitor rescheduled ${event.rescheduled} step(s)`)
    }
  }
}

/**
 * Say, at startup, whether email will work and where it will go.
 *
 * Without this the email step reports itself unconfigured for the first time
 * on the first run that reaches it — which is after a webhook has been
 * accepted and a run created, and reads as a flow problem rather than a
 * missing environment variable.
 *
 * The password is never printed, and its absence is not treated as an error:
 * plenty of relays authenticate by IP.
 */
export function describeEmail(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.SMTP_HOST
  if (host === undefined || host === '') {
    return '    email    not configured — set SMTP_HOST to send'
  }

  const port = env.SMTP_PORT ?? '587'
  const from = env.SMTP_FROM ?? '(SMTP_FROM is not set — the server will refuse to start)'
  const allowed = (env.SMTP_ALLOWED_RECIPIENTS ?? '').trim()

  const lines = [`    email    ${host}:${port} as ${from}`]

  if (allowed === '') {
    // The open-relay condition, stated as such. A flow's recipient comes from
    // a webhook body, so an unrestricted relay lets whoever can reach the
    // endpoint choose who this server writes to.
    lines.push(
      '             WARNING: SMTP_ALLOWED_RECIPIENTS is not set, so this will',
      '             send anywhere a published flow names.',
    )
  } else {
    lines.push(`             will only send to ${allowed}`)
  }

  return lines.join(NEWLINE)
}

const NEWLINE = String.fromCharCode(10)

export function describeStartupFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors
      .map((inner) => (inner as { message?: string }).message ?? String(inner))
      .filter((message, index, all) => all.indexOf(message) === index)

    return [
      `Could not start: ${error.message === '' ? 'connection failed' : error.message}`,
      ...causes.map((cause) => `  ${cause}`),
      '',
      'If those are database ports, the stack may not be up:',
      '  npm run db:up',
      'On Windows, WSL sometimes drops its port forwarding after an idle shutdown,',
      'and the containers look healthy from inside WSL while being unreachable from',
      'Windows. "docker compose restart" re-publishes them.',
    ].join(NEWLINE)
  }

  if (error instanceof Error) {
    return error.stack ?? error.message
  }
  return String(error)
}

if (process.argv[1]?.endsWith('server.ts')) {
  const config = loadConfig()
  buildServer({ config })
    .then(async (server) => {
      // Loopback by default. It bound 0.0.0.0 before, which put an
      // unauthenticated publish endpoint on every interface — reachable from
      // anything on the same network. Widening it now requires HOST, and
      // setting HOST to anything but loopback requires API_KEY.
      await server.app.listen({ port: config.port, host: config.host })
      console.log(`\n  AutomaBuild is running.`)
      console.log(`    UI       http://localhost:${config.port}/`)
      console.log(`    webhook  POST http://localhost:${config.port}/webhooks/${config.endpointId}`)
      console.log(`    runs     http://localhost:${config.port}/api/runs`)
      console.log(describeEmail())
      console.log()
    })
    .catch((error: unknown) => {
      console.error(describeStartupFailure(error))
      process.exit(1)
    })
}
