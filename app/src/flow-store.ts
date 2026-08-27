/**
 * Published flow versions.
 *
 * Every publish inserts a new row. That is the whole point: a run records the
 * `flow_version_id` it started on, and the worker resolves the definition by
 * that id, so a run already in flight keeps finishing against the version it
 * began with. Updating a row in place would rewrite history underneath a run
 * that was still using it.
 *
 * The canvas document is stored rather than the compiled definition, because
 * the editor has to load it back to show what is live. Recompiling on read is
 * cheap; decompiling is not possible.
 */

import type { Pool } from 'pg'

import { compileFlow, type CanvasGraph, type CompileProblem } from './flow.ts'
import type { FlowDefinition } from 'automa-durable-runner'

export interface PublishedFlow {
  readonly versionId: string
  readonly flowId: string
  readonly graph: CanvasGraph
  readonly publishedAt: Date
  readonly publishedBy: string | null
}

export interface FlowStoreOptions {
  readonly pool: Pool
  readonly tenantId: string
  readonly flowId: string
}

export type PublishResult =
  | { readonly ok: true; readonly published: PublishedFlow }
  | { readonly ok: false; readonly problems: readonly CompileProblem[] }

export class FlowStore {
  readonly #pool: Pool
  readonly #tenantId: string
  readonly #flowId: string

  /**
   * Compiled definitions, keyed by version.
   *
   * A cache the worker reads on every step, and safe to hold forever because a
   * version is immutable by construction — a publish makes a new one rather
   * than changing this one. Bounded by how many versions a process sees in its
   * lifetime, which is how many times someone pressed Publish.
   */
  readonly #compiled = new Map<string, FlowDefinition>()

  constructor(options: FlowStoreOptions) {
    this.#pool = options.pool
    this.#tenantId = options.tenantId
    this.#flowId = options.flowId
  }

  /** The version that new runs should use, or null if nothing is published. */
  async current(): Promise<PublishedFlow | null> {
    const { rows } = await this.#pool.query(
      `SELECT version_id, flow_id, graph, published_at, published_by
         FROM published_flows
        WHERE tenant_id = $1 AND flow_id = $2
        ORDER BY published_at DESC, version_id DESC
        LIMIT 1`,
      [this.#tenantId, this.#flowId],
    )
    return rows.length === 0 ? null : toPublished(rows[0])
  }

  async byVersion(versionId: string): Promise<PublishedFlow | null> {
    const { rows } = await this.#pool.query(
      `SELECT version_id, flow_id, graph, published_at, published_by
         FROM published_flows
        WHERE version_id = $1`,
      [versionId],
    )
    return rows.length === 0 ? null : toPublished(rows[0])
  }

  /**
   * The resolver the worker is given.
   *
   * Returning null means the version is genuinely not there, which the engine
   * treats as a step failure that will not be retried. That is right: a
   * version does not come back.
   */
  resolver(): (versionId: string) => Promise<FlowDefinition | null> {
    return async (versionId: string) => {
      const cached = this.#compiled.get(versionId)
      if (cached !== undefined) return cached

      const published = await this.byVersion(versionId)
      if (published === null) return null

      const compiled = compileFlow(published.graph, {
        flowId: published.flowId,
        versionId: published.versionId,
      })
      if (!compiled.ok) {
        // A stored version that no longer compiles. It compiled when it was
        // published, so this means the compiler changed under it — worth being
        // loud about, and worth failing the step rather than running a flow
        // nobody can describe.
        return null
      }

      this.#compiled.set(versionId, compiled.flow)
      return compiled.flow
    }
  }

  /**
   * Publish a graph as a new version.
   *
   * Compiled before it is stored, never after. A version that cannot run must
   * not become the one new runs are created against — the failure belongs to
   * whoever pressed the button, while they are still looking at the editor.
   */
  async publish(
    graph: CanvasGraph,
    options: { versionId: string; publishedBy?: string },
  ): Promise<PublishResult> {
    const compiled = compileFlow(graph, { flowId: this.#flowId, versionId: options.versionId })
    if (!compiled.ok) return { ok: false, problems: compiled.problems }

    const { rows } = await this.#pool.query(
      `INSERT INTO published_flows (version_id, flow_id, tenant_id, graph, published_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING version_id, flow_id, graph, published_at, published_by`,
      [
        options.versionId,
        this.#flowId,
        this.#tenantId,
        JSON.stringify(graph),
        options.publishedBy ?? null,
      ],
    )

    // Seed the cache from what was just compiled rather than making the first
    // step of the first run go back to the database for it.
    this.#compiled.set(options.versionId, compiled.flow)

    return { ok: true, published: toPublished(rows[0]) }
  }
}

function toPublished(row: {
  version_id: string
  flow_id: string
  graph: CanvasGraph
  published_at: Date
  published_by: string | null
}): PublishedFlow {
  return {
    versionId: row.version_id,
    flowId: row.flow_id,
    graph: row.graph,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
  }
}
