/**
 * Apply migrations to the configured database.
 *
 *   npm run db:migrate
 */

import { Client } from 'pg'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { migrate } from '../src/db/migrate.ts'
import { dbConfigFromEnv } from '../src/db/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', 'migrations')

const client = new Client(dbConfigFromEnv())
await client.connect()

try {
  const result = await migrate(client, migrationsDir, {
    log: (message) => console.log(message),
  })
  if (result.applied.length === 0) {
    console.log(`nothing to apply (${result.skipped.length} already applied)`)
  } else {
    console.log(`applied ${result.applied.length}, skipped ${result.skipped.length}`)
  }
} finally {
  await client.end()
}
