import { isScheme, type Scheme } from 'automa-webhook-gate'

import { resolveApiKey } from './auth.ts'

/**
 * One place where the environment is read.
 *
 * Everything that can be wrong about a deployment is wrong here, at startup,
 * rather than on the first webhook at three in the morning. A missing secret
 * is a refusal to start, not a 401 that looks like the sender's fault.
 */

export interface AppConfig {
  readonly port: number
  /** Bind address. Loopback is what makes an absent API key acceptable. */
  readonly host: string
  /** Null only when bound to loopback — see resolveApiKey. */
  readonly apiKey: string | null
  readonly tenantId: string
  readonly endpointId: string
  readonly scheme: Scheme
  readonly secrets: readonly string[]
  readonly canvasDir: string
  readonly gateDb: DbEnv
  readonly runnerDb: DbEnv
}

export interface DbEnv {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
}

function db(env: NodeJS.ProcessEnv, prefix: string, defaults: Partial<DbEnv>): DbEnv {
  // Deliberately no PGHOST/PGUSER fallback: there are two databases here, and
  // a variable that applies to both at once would silently point the engine at
  // the gate's database or the reverse.
  const get = (key: string, fallback?: string): string => {
    const value = env[`${prefix}_${key}`] ?? fallback
    if (value === undefined) throw new Error(`${prefix}_${key} is not set`)
    return value
  }
  return {
    host: get('HOST', defaults.host ?? 'localhost'),
    port: Number(get('PORT', String(defaults.port ?? 5432))),
    user: get('USER', defaults.user ?? 'automa'),
    password: get('PASSWORD', defaults.password ?? 'automa'),
    database: get('DATABASE', defaults.database ?? 'automa'),
  }
}

/**
 * Both libraries key their tables on uuid columns, so a friendly string here
 * becomes `invalid input syntax for type uuid` on the first delivery — after
 * the signature has already been verified, which makes it look like the
 * sender's problem. Checked at startup instead.
 */
function requireUuid(name: string, value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID (both databases key on uuid columns); got ${value}`)
  }
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = env.WEBHOOK_SECRETS ?? env.WEBHOOK_SECRET ?? ''
  const secrets = raw
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret !== '')

  if (secrets.length === 0) {
    throw new Error(
      'WEBHOOK_SECRETS is not set. Set it to the signing secret, or to a ' +
        'comma-separated list of them while a secret is being rotated.',
    )
  }

  const scheme = (env.WEBHOOK_SCHEME ?? 'stripe') as AppConfig['scheme']
  if (!isScheme(scheme)) {
    throw new Error(`WEBHOOK_SCHEME is ${scheme}, which is not a scheme this verifies.`)
  }

  const host = env.HOST ?? '127.0.0.1'

  return {
    port: Number(env.PORT ?? 8080),
    host,
    // Throws rather than returning null when bound to anything but loopback.
    // A warning would scroll past and the thing would be exposed anyway.
    apiKey: resolveApiKey(env, host),
    // Fixed defaults rather than generated ones: a demo that invents a new
    // tenant each start would show an empty history every time, which looks
    // like the runs were lost.
    tenantId: requireUuid('TENANT_ID', env.TENANT_ID ?? '00000000-0000-4000-8000-000000000001'),
    endpointId: requireUuid('ENDPOINT_ID', env.ENDPOINT_ID ?? '00000000-0000-4000-8000-0000000000e1'),
    scheme,
    secrets,
    // The canvas is built separately and served from here. Pointing at a
    // directory that is not there is a startup error rather than a 404 per
    // request, because a UI that silently does not exist is hard to notice.
    //
    // A sibling workspace package now, rather than a sibling checkout. It used
    // to be `../../automa-flow-canvas/dist`, which only resolved if the editor
    // happened to be cloned next to this repository — the one piece of the
    // system that could not be obtained by cloning it.
    canvasDir: env.CANVAS_DIR ?? '../packages/automa-flow-canvas/dist',
    // Two databases, because the gate and the engine are two independent
    // libraries with their own migrations. They can point at the same
    // Postgres — and by default they do, on separate ports in compose — but
    // neither one is allowed to assume the other's tables exist.
    gateDb: db(env, 'GATE_DB', {
      port: 54341,
      user: 'webhookgate',
      password: 'webhookgate',
      database: 'webhookgate',
    }),
    runnerDb: db(env, 'RUNNER_DB', {
      port: 54339,
      user: 'automa',
      password: 'automa',
      database: 'automa',
    }),
  }
}
