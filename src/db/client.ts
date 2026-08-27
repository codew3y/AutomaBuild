/**
 * Connection handling and the transaction helper.
 *
 * Every state change in this engine happens inside a transaction that also
 * writes the outbox row scheduling whatever comes next. That is the whole
 * point of the outbox pattern, and it only works if enqueueing cannot happen
 * outside the transaction — hence `Executor` being the type the repository
 * accepts rather than a pool.
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { type DbConfig, dbConfigFromEnv } from './config.ts'

/**
 * Anything that can run a statement: a pool, a pooled client, or a client
 * already inside a transaction.
 *
 * Repository functions take this rather than a pool so a caller cannot
 * accidentally run half of a state transition on a different connection, which
 * would silently place it outside the transaction.
 */
export interface Executor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>
}

export function createPool(config: DbConfig = dbConfigFromEnv()): Pool {
  return new Pool({
    ...config,
    // The engine holds connections only for short transactions. A large pool
    // here mostly buys the ability to exhaust Postgres.
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  })
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw.
 *
 * Serialization failures and deadlocks are retried, because under
 * `SKIP LOCKED` contention they are ordinary and not a symptom of anything.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 3
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      lastError = error
      const code = (error as { code?: string }).code
      // 40001 serialization_failure, 40P01 deadlock_detected
      if (code !== '40001' && code !== '40P01') throw error
    } finally {
      client.release()
    }
  }

  throw lastError
}
