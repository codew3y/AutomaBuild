/**
 * Run both libraries' migrations, each against its own database.
 *
 * Each library owns its schema and ships its own migration files; this only
 * points them at the right place and reports what happened. Both check the
 * recorded checksum of an applied migration, so an edited migration is an
 * error here rather than a database that quietly disagrees with the files.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Client } from 'pg'
import { createPool as createGatePool, migrate as migrateGate } from 'automa-webhook-gate'
import { migrate as migrateRunner } from 'automa-durable-runner'

import { loadConfig } from './config.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** The migrations ship inside each package, so they are resolved from there
 *  rather than copied — a copy is a second history to keep in step. */
function migrationsOf(pkg: string): string {
  const entry = fileURLToPath(import.meta.resolve(pkg))
  return join(dirname(dirname(entry)), 'migrations')
}

export async function runMigrations(log: (message: string) => void = console.log): Promise<void> {
  const config = loadConfig()

  const gatePool = createGatePool(config.gateDb)
  // The engine migrates on a single connection rather than a pool, because
  // some of its migrations take an advisory lock and set session state; on a
  // pool the next statement can land on a different connection and the lock is
  // silently not held.
  const runnerClient = new Client(config.runnerDb)
  await runnerClient.connect()

  try {
    log('gate:')
    const gate = await migrateGate(gatePool, migrationsOf('automa-webhook-gate'), (m) => log(`  ${m}`))
    log(`  applied ${gate.applied.length}, already present ${gate.skipped.length}`)

    log('runner:')
    const runner = await migrateRunner(runnerClient, migrationsOf('automa-durable-runner'), {
      log: (m) => log(`  ${m}`),
    })
    log(`  applied ${runner.applied.length}, already present ${runner.skipped.length}`)

    // This application owns one table of its own — published flow versions —
    // and runs it alongside the engine's, in the engine's database. It is
    // deliberately not part of either library's history: neither of them has
    // an opinion about where a flow definition comes from.
    log('app:')
    const app = await migrateRunner(runnerClient, join(here, '..', 'migrations'), {
      log: (m) => log(`  ${m}`),
    })
    log(`  applied ${app.applied.length}, already present ${app.skipped.length}`)
  } finally {
    await Promise.all([gatePool.end(), runnerClient.end()])
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate.ts')) {
  runMigrations().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    },
  )
}
