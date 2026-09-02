/**
 * Where the database is.
 *
 * Defaults point at the docker-compose stack on non-standard ports, so a
 * running local Postgres cannot be hit by accident — a test suite that
 * truncates tables should never be one typo away from a real database.
 */

export interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    host: env.PGHOST ?? '127.0.0.1',
    port: Number(env.PGPORT ?? 54329),
    user: env.PGUSER ?? 'automa',
    password: env.PGPASSWORD ?? 'automa',
    database: env.PGDATABASE ?? 'automa',
  }
}
