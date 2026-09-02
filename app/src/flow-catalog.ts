/**
 * The flows a tenant has, and the endpoint each receives on.
 *
 * A flow used to exist only as an id repeated across three tables. Nothing said
 * what it was, so the editor could not offer a list and there was in practice
 * exactly one flow whose id was a constant in the server.
 *
 * Creating a flow creates its endpoint in the same transaction. The two are
 * useless apart — a flow with no endpoint can never be triggered, and an
 * endpoint with no flow has nothing to start — and creating them separately
 * would leave a window where one exists without the other, which someone would
 * eventually find by hitting a 404 they could not explain.
 */

import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Scheme } from 'automa-webhook-gate'

import { resolveSecrets } from './secret-source.ts'

export interface FlowSummary {
  readonly flowId: string
  readonly tenantId: string
  readonly name: string
  readonly endpointId: string | null
  readonly scheme: Scheme | null
  readonly archived: boolean
  readonly createdAt: Date

  /** Null when the flow has never been published. */
  readonly publishedAt: Date | null
  readonly runCount: number
  readonly lastRunAt: Date | null
  readonly lastRunStatus: string | null
}

export interface CreateFlowInput {
  readonly tenantId: string
  readonly name: string
  readonly scheme?: Scheme
  /** References, never values — see secret-source.ts. */
  readonly secretRefs: readonly string[]
}

export class FlowCatalog {
  readonly #pool: Pool

  constructor(pool: Pool) {
    this.#pool = pool
  }

  async list(tenantId: string): Promise<FlowSummary[]> {
    // Left join: a flow whose only endpoint was disabled still has to appear,
    // or it would vanish from the editor with its versions and runs intact.
    // The counts come from lateral subqueries rather than a group-by across
    // three joins: an overview that lists ten flows should be ten cheap indexed
    // lookups, not one query whose cost grows with the run table.
    const { rows } = await this.#pool.query(
      `SELECT f.flow_id, f.tenant_id, f.name, f.archived_at, f.created_at,
              e.endpoint_id, e.scheme,
              p.published_at,
              COALESCE(r.run_count, 0) AS run_count,
              r.last_run_at, r.last_run_status
         FROM flows f
         LEFT JOIN endpoints e
           ON e.flow_id = f.flow_id AND e.disabled_at IS NULL
         LEFT JOIN LATERAL (
           SELECT published_at
             FROM published_flows pf
            WHERE pf.flow_id = f.flow_id AND pf.tenant_id = f.tenant_id
            ORDER BY published_at DESC
            LIMIT 1
         ) p ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS run_count,
                  max(started_at) AS last_run_at,
                  (SELECT status FROM runs r2
                    WHERE r2.flow_id = f.flow_id AND r2.tenant_id = f.tenant_id
                    ORDER BY started_at DESC LIMIT 1) AS last_run_status
             FROM runs
            WHERE runs.flow_id = f.flow_id AND runs.tenant_id = f.tenant_id
         ) r ON true
        WHERE f.tenant_id = $1 AND f.archived_at IS NULL
        ORDER BY f.created_at`,
      [tenantId],
    )
    return rows.map(toSummary)
  }

  async byId(flowId: string): Promise<FlowSummary | null> {
    if (!UUID.test(flowId)) return null
    const { rows } = await this.#pool.query(
      `SELECT f.flow_id, f.tenant_id, f.name, f.archived_at, f.created_at,
              e.endpoint_id, e.scheme
         FROM flows f
         LEFT JOIN endpoints e
           ON e.flow_id = f.flow_id AND e.disabled_at IS NULL
        WHERE f.flow_id = $1`,
      [flowId],
    )
    return rows.length === 0 ? null : toSummary(rows[0])
  }

  /** Register a flow that already exists as an id, so seeding is idempotent. */
  async ensure(flowId: string, tenantId: string, name: string): Promise<FlowSummary> {
    await this.#pool.query(
      `INSERT INTO flows (flow_id, tenant_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (flow_id) DO NOTHING`,
      [flowId, tenantId, name],
    )
    const found = await this.byId(flowId)
    if (found === null) throw new Error(`flow ${flowId} vanished after insert`)
    return found
  }

  /**
   * Create a flow and the endpoint it receives on, together.
   *
   * The secret references are resolved before anything is written. Storing a
   * reference to a variable that does not exist would leave a flow that cannot
   * ever receive a delivery, discovered later as a 401 that looks like the
   * sender's fault.
   */
  async create(input: CreateFlowInput): Promise<FlowSummary> {
    resolveSecrets(input.secretRefs)

    const name = input.name.trim()
    if (name === '') throw new Error('a flow needs a name')

    const flowId = randomUUID()
    const endpointId = randomUUID()

    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO flows (flow_id, tenant_id, name) VALUES ($1, $2, $3)`, [
        flowId,
        input.tenantId,
        name,
      ])
      await client.query(
        `INSERT INTO endpoints (endpoint_id, tenant_id, flow_id, scheme, secrets)
         VALUES ($1, $2, $3, $4, $5)`,
        [endpointId, input.tenantId, flowId, input.scheme ?? 'stripe', [...input.secretRefs]],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const created = await this.byId(flowId)
    if (created === null) throw new Error(`flow ${flowId} vanished after insert`)
    return created
  }

  /**
   * Archive a flow, and switch off the endpoint it received on.
   *
   * Archived rather than deleted. Runs and published versions reference the
   * flow id, and every one of those rows is a record of something that
   * actually happened — deleting the flow would either orphan them or take the
   * history with it, and "why did this run vanish" is a far worse question than
   * a list with one fewer entry in it.
   *
   * The endpoint is disabled in the same transaction: a live webhook address
   * feeding an archived flow would accept deliveries and start runs nobody is
   * looking at. Disabled rather than deleted for the same reason, and because
   * the partial unique index then lets the id be reused by a replacement.
   */
  async archive(flowId: string, tenantId: string): Promise<boolean> {
    // Checked here as well as in byId: Postgres raises on a malformed uuid
    // rather than matching no rows, which turns "no such flow" into a 500.
    if (!UUID.test(flowId)) return false

    const client = await this.#pool.connect()
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        `UPDATE flows SET archived_at = now()
          WHERE flow_id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
        [flowId, tenantId],
      )
      if ((rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `UPDATE endpoints SET disabled_at = now()
          WHERE flow_id = $1 AND tenant_id = $2 AND disabled_at IS NULL`,
        [flowId, tenantId],
      )
      await client.query('COMMIT')
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async rename(flowId: string, tenantId: string, name: string): Promise<boolean> {
    if (!UUID.test(flowId)) return false
    const trimmed = name.trim()
    if (trimmed === '') throw new Error('a flow needs a name')
    const { rowCount } = await this.#pool.query(
      `UPDATE flows SET name = $3 WHERE flow_id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
      [flowId, tenantId, trimmed],
    )
    return (rowCount ?? 0) > 0
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toSummary(row: {
  flow_id: string
  tenant_id: string
  name: string
  archived_at: Date | null
  created_at: Date
  endpoint_id: string | null
  scheme: string | null
  published_at?: Date | null
  run_count?: number
  last_run_at?: Date | null
  last_run_status?: string | null
}): FlowSummary {
  return {
    flowId: row.flow_id,
    tenantId: row.tenant_id,
    name: row.name,
    endpointId: row.endpoint_id,
    scheme: (row.scheme as Scheme | null) ?? null,
    archived: row.archived_at !== null,
    createdAt: row.created_at,
    // The single-row lookups do not join these, so they are absent rather than
    // zero there — and a card that says "0 runs" for a flow nobody counted
    // would be stating something it does not know.
    publishedAt: row.published_at ?? null,
    runCount: row.run_count ?? 0,
    lastRunAt: row.last_run_at ?? null,
    lastRunStatus: row.last_run_status ?? null,
  }
}
