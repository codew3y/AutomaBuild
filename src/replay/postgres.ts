/**
 * The Postgres replay store — the one that actually protects anything.
 *
 * The check and the record are a single `INSERT ... ON CONFLICT DO NOTHING`.
 * That is not a stylistic preference: it is what makes the guarantee hold when
 * two copies of a replayed request arrive at two processes at the same
 * instant. A `SELECT` followed by an `INSERT` has a window between them, and
 * both copies would find nothing and both be accepted — the exact attack this
 * table exists to stop.
 *
 * `ON CONFLICT DO NOTHING` reports zero rows affected when the key was already
 * there, so one statement answers both questions: is this new, and it is now
 * recorded.
 */

import type { Pool } from 'pg'
import {
  DEFAULT_RETENTION_SECONDS,
  type DeliveryRecord,
  type RecordResult,
  type ReplayStore,
} from './store.ts'

export interface PostgresStoreOptions {
  readonly retentionSeconds?: number
}

export class PostgresReplayStore implements ReplayStore {
  readonly #pool: Pool
  readonly #retentionSeconds: number

  constructor(pool: Pool, options: PostgresStoreOptions = {}) {
    this.#pool = pool
    this.#retentionSeconds = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS
  }

  async record(record: DeliveryRecord): Promise<RecordResult> {
    // Rejections are not remembered.
    //
    // If they were, an attacker could burn a legitimate delivery's key by
    // sending it first with a broken signature: the record would exist, and
    // the genuine delivery arriving moments later would be dismissed as a
    // duplicate and silently dropped. A denial of service built out of the
    // replay protection itself.
    if (record.outcome !== 'accepted') return { first: true }

    const { rows } = await this.#pool.query<{ received_at: Date }>(
      `INSERT INTO webhook_deliveries (endpoint_id, dedup_key, outcome, received_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint_id, dedup_key) DO NOTHING
       RETURNING received_at`,
      [record.endpointId, record.dedupKey, record.outcome, record.receivedAt],
    )

    if (rows.length === 1) return { first: true }

    // Nothing was inserted, so the key was already present. Read when the
    // original arrived — useful in a log line, and worth distinguishing from
    // "we have no idea".
    const existing = await this.#pool.query<{ received_at: Date }>(
      `SELECT received_at FROM webhook_deliveries
        WHERE endpoint_id = $1 AND dedup_key = $2`,
      [record.endpointId, record.dedupKey],
    )
    return {
      first: false,
      ...(existing.rows[0] === undefined ? {} : { originallyAt: existing.rows[0].received_at }),
    }
  }

  async prune(olderThan: Date): Promise<number> {
    const { rowCount } = await this.#pool.query(
      `DELETE FROM webhook_deliveries WHERE received_at < $1`,
      [olderThan],
    )
    return rowCount ?? 0
  }

  /** Delete everything older than the retention window. For a scheduled sweep. */
  async pruneExpired(now: Date = new Date()): Promise<number> {
    return this.prune(new Date(now.getTime() - this.#retentionSeconds * 1000))
  }

  get retentionSeconds(): number {
    return this.#retentionSeconds
  }
}
