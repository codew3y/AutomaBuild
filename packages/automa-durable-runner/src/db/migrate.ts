/**
 * A migration runner, deliberately small.
 *
 * Two properties matter and neither needs a library:
 *
 * 1. **Each migration runs inside a transaction**, so a failure halfway
 *    through leaves no partial schema. Postgres has transactional DDL, which
 *    is the reason this is twenty lines rather than a framework.
 *
 * 2. **A migration that has already run is never re-run**, and its content is
 *    checksummed, so editing an applied migration is an error rather than a
 *    silent divergence between what the file says and what the database has.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from 'pg'

export interface Migration {
  readonly name: string
  readonly sql: string
  readonly checksum: string
}

export interface MigrationResult {
  readonly applied: readonly string[]
  readonly skipped: readonly string[]
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text        PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory)
  const files = entries.filter((name) => name.endsWith('.sql')).sort()

  const migrations: Migration[] = []
  for (const name of files) {
    const sql = await readFile(join(directory, name), 'utf8')
    migrations.push({
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    })
  }
  return migrations
}

export class MigrationDriftError extends Error {
  override readonly name = 'MigrationDriftError'
  constructor(migration: string, expected: string, actual: string) {
    super(
      `Migration ${migration} has changed since it was applied ` +
        `(recorded ${expected}, file is now ${actual}). ` +
        `Applied migrations are history — add a new migration instead of editing this one.`,
    )
  }
}

export async function migrate(
  client: Client,
  directory: string,
  options: { log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const log = options.log ?? (() => {})
  await client.query(LEDGER)

  const migrations = await loadMigrations(directory)
  const { rows } = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  )
  const alreadyApplied = new Map(rows.map((row) => [row.name, row.checksum]))

  const applied: string[] = []
  const skipped: string[] = []

  for (const migration of migrations) {
    const recorded = alreadyApplied.get(migration.name)
    if (recorded !== undefined) {
      if (recorded !== migration.checksum) {
        throw new MigrationDriftError(migration.name, recorded, migration.checksum)
      }
      skipped.push(migration.name)
      continue
    }

    log(`applying ${migration.name}`)
    await client.query('BEGIN')
    try {
      await client.query(migration.sql)
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ])
      await client.query('COMMIT')
      applied.push(migration.name)
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }

  return { applied, skipped }
}
