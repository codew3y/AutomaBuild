/**
 * Database connection and migrations.
 *
 * Small on purpose: this project has one table, and a migration framework
 * would be more machinery than schema. What it does keep is the two properties
 * that matter — each migration runs in a transaction, and an applied migration
 * is checksummed so editing one is an error rather than a silent divergence
 * between the file and the database.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolConfig } from 'pg'

export interface DbConfig extends PoolConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.PGHOST ?? '127.0.0.1',
    port: Number(env.PGPORT ?? 54331),
    user: env.PGUSER ?? 'webhookgate',
    password: env.PGPASSWORD ?? 'webhookgate',
    database: env.PGDATABASE ?? 'webhookgate',
  }
}

export function createPool(config: DbConfig = dbConfigFromEnv()): Pool {
  return new Pool({ ...config, max: 10, connectionTimeoutMillis: 5_000 })
}

export class MigrationDriftError extends Error {
  override readonly name = 'MigrationDriftError'
  constructor(name: string, recorded: string, actual: string) {
    super(
      `Migration ${name} changed after it was applied (recorded ${recorded}, now ${actual}). ` +
        `Applied migrations are history — add a new one instead of editing this.`,
    )
  }
}

export async function migrate(
  pool: Pool,
  directory: string,
  log: (message: string) => void = () => {},
): Promise<{ applied: string[]; skipped: string[] }> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const files = (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  )
  const already = new Map(rows.map((row) => [row.name, row.checksum]))

  const applied: string[] = []
  const skipped: string[] = []

  for (const name of files) {
    const sql = await readFile(join(directory, name), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16)

    const recorded = already.get(name)
    if (recorded !== undefined) {
      if (recorded !== checksum) throw new MigrationDriftError(name, recorded, checksum)
      skipped.push(name)
      continue
    }

    log(`applying ${name}`)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        name,
        checksum,
      ])
      await client.query('COMMIT')
      applied.push(name)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`, { cause: error })
    } finally {
      client.release()
    }
  }

  return { applied, skipped }
}
