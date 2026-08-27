/**
 * Who may use the control API.
 *
 * The webhook route is deliberately *not* covered by this: it authenticates
 * every request already, by signature, and that is the stronger check. This is
 * about everything else — publishing a flow, and reading run history.
 *
 * Publishing is the dangerous one, and it is worth being explicit about why. A
 * published flow is a list of URLs this server will fetch and addresses it will
 * email, on a schedule someone else triggers. An unauthenticated publish
 * endpoint is therefore a remote instruction to make outbound requests, and no
 * amount of SSRF hardening on the client makes that acceptable — `safe-fetch`
 * stops the request reaching a metadata endpoint, it does not stop a stranger
 * deciding what this server talks to.
 *
 * Reading is not harmless either: a run carries the webhook payload that
 * started it, and the outputs of every step. That is customer data.
 *
 * The check is a shared secret in a header, compared in constant time. Not
 * because a timing attack on this is likely, but because the alternative costs
 * nothing and the habit is worth keeping.
 */

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export const API_KEY_HEADER = 'x-automabuild-key'

/**
 * Compare without leaking length or content through timing.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would leak
 * length through the exception — so length is folded into the comparison
 * instead of being checked first.
 */
export function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Still do the work, against a buffer of the right size, so that a wrong
    // length costs the same as a wrong value.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export interface ApiAuthOptions {
  /** Null disables the check, which is only permitted on loopback. */
  readonly apiKey: string | null
  /** Paths the check does not apply to. */
  readonly publicPrefixes?: readonly string[]
}

/**
 * The paths that are open regardless.
 *
 * The webhook route carries its own authentication. The canvas itself and its
 * assets have to load before anyone can type a key. Health is deliberately
 * open so a load balancer does not need a credential.
 */
const DEFAULT_PUBLIC: readonly string[] = ['/webhooks/', '/api/health']

/** Is this a control-API path, as opposed to the UI or a webhook? */
function isProtected(url: string, publicPrefixes: readonly string[]): boolean {
  const path = url.split('?')[0] ?? url
  if (publicPrefixes.some((prefix) => path.startsWith(prefix))) return false
  return path.startsWith('/api/')
}

export function registerApiAuth(app: FastifyInstance, options: ApiAuthOptions): void {
  const publicPrefixes = [...DEFAULT_PUBLIC, ...(options.publicPrefixes ?? [])]

  if (options.apiKey === null) return

  const apiKey = options.apiKey

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isProtected(request.url, publicPrefixes)) return

    const presented = request.headers[API_KEY_HEADER]
    const value = Array.isArray(presented) ? presented[0] : presented

    if (value === undefined || !secretMatches(value, apiKey)) {
      // 401 with no detail. Saying whether the header was missing or merely
      // wrong tells an attacker which half to work on.
      return reply.code(401).send({ error: 'unauthorized' })
    }
  })
}

/**
 * Decide whether running without a key is acceptable.
 *
 * On loopback it is: the thing is a local dev tool and demanding a credential
 * to open your own editor is friction with no defender. Bound to anything else
 * it is not, and the server refuses to start rather than coming up open — a
 * warning would scroll past and the thing would be exposed anyway.
 */
export function resolveApiKey(env: NodeJS.ProcessEnv, host: string): string | null {
  const key = env.API_KEY ?? ''
  if (key !== '') return key

  const loopbackOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (loopbackOnly) return null

  throw new Error(
    [
      `Refusing to listen on ${host} without API_KEY set.`,
      '',
      'The control API publishes flows and reads run history. A published flow',
      'is a list of URLs this server will fetch and addresses it will email, so',
      'an open publish endpoint lets a stranger decide what it talks to.',
      '',
      'Either set API_KEY, or bind to 127.0.0.1 for local use.',
    ].join('\n'),
  )
}
