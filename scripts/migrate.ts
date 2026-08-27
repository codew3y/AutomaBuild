/** Apply migrations. `npm run db:migrate` */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createPool, migrate } from '../src/db.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pool = createPool()
try {
  const result = await migrate(pool, join(here, '..', 'migrations'), (m) => console.log(m))
  console.log(
    result.applied.length === 0
      ? `nothing to apply (${result.skipped.length} already applied)`
      : `applied ${result.applied.length}, skipped ${result.skipped.length}`,
  )
} finally {
  await pool.end()
}
