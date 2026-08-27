/**
 * Which tenant an arriving webhook belongs to.
 *
 * This is the piece that was missing. The engine has scoped every table and
 * every query by `tenant_id` from its first migration, so isolation downstream
 * was never the problem — there was simply nothing at the edge that could
 * decide *which* tenant a request was for. One endpoint id in an environment
 * variable meant one tenant, and the README's first sentence was the least
 * accurate line in the repository.
 *
 * A delivery names its endpoint in the URL. The endpoint decides the tenant,
 * the flow, and the secrets the signature is checked against.
 */

import type { Pool } from 'pg'
import type { Scheme } from 'automa-webhook-gate'

import { describeSecretRef, resolveSecrets } from './secret-source.ts'

export interface Endpoint {
  readonly endpointId: string
  readonly tenantId: string
  readonly flowId: string
  readonly scheme: Scheme
  /**
   * The resolved signing secrets.
   *
   * What the database holds is a reference — `env:NAME`, `file:/path` or
   * `literal:value`. This is the resolved form, and it exists only in memory
   * for the life of one lookup.
   */
  readonly secrets: readonly string[]
  /** How each secret is stored, safe to log. Never the values. */
  readonly secretSources: readonly string[]
  /** References that could not be resolved, while at least one other could. */
  readonly secretProblems: readonly string[]
  readonly disabledAt: Date | null
}

export class EndpointStore {
  readonly #pool: Pool

  constructor(pool: Pool) {
    this.#pool = pool
  }

  /**
   * Look one up for a delivery.
   *
   * A disabled endpoint resolves to null, which the gate turns into the same
   * 404 an unknown id gets. Telling a caller that an endpoint exists but is
   * switched off confirms the id for them, and there is nothing they can do
   * with that answer except try again later.
   *
   * Not cached. The lookup is one indexed read on the primary key, and a cache
   * here would mean a rotated secret or a disabled endpoint kept working for
   * however long the entry lived — which is exactly the moment it must not.
   */
  async forDelivery(endpointId: string): Promise<Endpoint | null> {
    // A malformed id would make Postgres raise a type error rather than
    // returning no rows, and that would be a 500 for what is a 404.
    if (!isUuid(endpointId)) return null

    const { rows } = await this.#pool.query(
      `SELECT endpoint_id, tenant_id, flow_id, scheme, secrets, disabled_at
         FROM endpoints
        WHERE endpoint_id = $1 AND disabled_at IS NULL`,
      [endpointId],
    )
    return rows.length === 0 ? null : toEndpoint(rows[0])
  }

  async byId(endpointId: string): Promise<Endpoint | null> {
    if (!isUuid(endpointId)) return null
    const { rows } = await this.#pool.query(
      `SELECT endpoint_id, tenant_id, flow_id, scheme, secrets, disabled_at
         FROM endpoints WHERE endpoint_id = $1`,
      [endpointId],
    )
    return rows.length === 0 ? null : toEndpoint(rows[0])
  }

  async listForTenant(tenantId: string): Promise<Endpoint[]> {
    const { rows } = await this.#pool.query(
      `SELECT endpoint_id, tenant_id, flow_id, scheme, secrets, disabled_at
         FROM endpoints
        WHERE tenant_id = $1
        ORDER BY created_at DESC`,
      [tenantId],
    )
    return rows.map(toEndpoint)
  }

  /**
   * Create an endpoint, or leave an existing one exactly as it is.
   *
   * Used to seed the demo endpoint at startup, which happens on every boot. An
   * upsert would overwrite a secret someone had rotated by hand every time the
   * process restarted.
   */
  async ensure(endpoint: {
    endpointId: string
    tenantId: string
    flowId: string
    scheme: Scheme
    /** References, not values — see secret-source.ts. */
    secretRefs: readonly string[]
  }): Promise<Endpoint> {
    await this.#pool.query(
      `INSERT INTO endpoints (endpoint_id, tenant_id, flow_id, scheme, secrets)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint_id) DO NOTHING`,
      [
        endpoint.endpointId,
        endpoint.tenantId,
        endpoint.flowId,
        endpoint.scheme,
        [...endpoint.secretRefs],
      ],
    )
    const stored = await this.byId(endpoint.endpointId)
    if (stored === null) throw new Error(`endpoint ${endpoint.endpointId} vanished after insert`)
    return stored
  }

  /**
   * Replace how an endpoint's secrets are stored.
   *
   * References in, never values — the caller has already decided where the
   * secret should live. Used to move an endpoint off plaintext once its stored
   * value is known to match something already available elsewhere.
   */
  async setSecretRefs(endpointId: string, refs: readonly string[]): Promise<void> {
    if (refs.length === 0) throw new Error("an endpoint needs at least one secret")
    await this.#pool.query(`UPDATE endpoints SET secrets = $2 WHERE endpoint_id = $1`, [
      endpointId,
      [...refs],
    ])
  }
}


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

function toEndpoint(row: {
  endpoint_id: string
  tenant_id: string
  flow_id: string
  scheme: string
  secrets: string[]
  disabled_at: Date | null
}): Endpoint {
  // Resolved here, so nothing downstream ever has to know that a stored value
  // is a reference — and so a caller cannot accidentally verify a signature
  // against the string "env:WEBHOOK_SECRETS".
  const { secrets, problems } = resolveSecrets(row.secrets)

  return {
    endpointId: row.endpoint_id,
    tenantId: row.tenant_id,
    flowId: row.flow_id,
    scheme: row.scheme as Scheme,
    secrets,
    secretSources: row.secrets.map(describeSecretRef),
    secretProblems: problems,
    disabledAt: row.disabled_at,
  }
}
