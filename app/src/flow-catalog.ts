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
    const { rows } = await this.#pool.query(
      `SELECT f.flow_id, f.tenant_id, f.name, f.archived_at, f.created_at,
              e.endpoint_id, e.scheme
         FROM flows f
         LEFT JOIN endpoints e
           ON e.flow_id = f.flow_id AND e.disabled_at IS NULL
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

  async rename(flowId: string, tenantId: string, name: string): Promise<boolean> {
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
}): FlowSummary {
  return {
    flowId: row.flow_id,
    tenantId: row.tenant_id,
    name: row.name,
    endpointId: row.endpoint_id,
    scheme: (row.scheme as Scheme | null) ?? null,
    archived: row.archived_at !== null,
    createdAt: row.created_at,
  }
}
