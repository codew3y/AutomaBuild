/**
 * Raw-body capture for Fastify, and the webhook route.
 *
 * This is the fiddliest part of the project and the one most often got wrong,
 * because the framework is actively unhelpful here: Fastify parses JSON for
 * you by default, and by the time a handler runs the original bytes are gone.
 * Verifying the re-serialised object then fails for legitimate deliveries,
 * and the tempting fix is to stop verifying.
 *
 * `addContentTypeParser` replaces the parser for the content types a webhook
 * arrives as, keeping the buffer and parsing from it rather than the reverse.
 *
 * The size cap is enforced by Fastify's `bodyLimit` *before* the body is
 * assembled, which matters: checking afterwards means the memory has already
 * been spent, and an attacker can exhaust a process with requests that are
 * then dutifully rejected.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DEFAULT_MAX_BODY_BYTES } from './verify/common.ts'
import type { EndpointConfig, GateResult, createGate } from './gate.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** The bytes exactly as they arrived, before any parsing. */
    rawBody?: Buffer
  }
}

export interface RawBodyOptions {
  readonly maxBodyBytes?: number
  /**
   * Content types to capture. Webhooks are not always JSON — Slack sends
   * form-encoded payloads for some events, and a verifier that assumes JSON
   * cannot check them at all.
   */
  readonly contentTypes?: readonly string[]
}

export const DEFAULT_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
  'text/plain',
] as const

/**
 * Capture the raw body for the given content types.
 *
 * A plain function rather than a Fastify plugin, deliberately.
 *
 * Content type parsers are *encapsulated*: registering this with
 * `app.register()` puts the parser in a new child scope, where routes
 * registered in the parent cannot see it. Everything looks correct — the
 * plugin runs, the parser is added — and every webhook gets a 415 that reads
 * like the client sent the wrong content type. Calling it directly on the
 * instance the routes live on removes the possibility.
 *
 * Applies to the instance it is given and its children, so scoping it to a
 * webhook subtree still works; what it will not do is silently apply to
 * nothing.
 */
export function registerRawBody(app: FastifyInstance, options: RawBodyOptions = {}): void {
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const types = options.contentTypes ?? DEFAULT_CONTENT_TYPES

  for (const contentType of types) {
    app.addContentTypeParser(
      contentType,
      { parseAs: 'buffer', bodyLimit: limit },
      (request: FastifyRequest, payload: Buffer, next) => {
        // Keep the bytes first. Everything downstream depends on these being
        // untouched, so nothing is allowed to happen before they are stored.
        request.rawBody = payload

        if (contentType === 'application/json') {
          // Parsed for convenience only. A parse failure is not fatal here —
          // the signature covers the bytes, not the object, so an unparseable
          // body can still be authenticated and rejected on its merits rather
          // than dismissed as malformed before anyone checks who sent it.
          try {
            next(null, payload.length === 0 ? undefined : JSON.parse(payload.toString('utf8')))
            return
          } catch {
            next(null, undefined)
            return
          }
        }
        next(null, payload)
      },
    )
  }
}

export interface WebhookRouteOptions {
  readonly path?: string
  readonly gate: ReturnType<typeof createGate>
  /** Look up an endpoint's configuration, or null if there is no such endpoint. */
  readonly lookup: (endpointId: string) => Promise<EndpointConfig | null> | EndpointConfig | null
  /** Called once for a genuinely new delivery. Errors here become a 500. */
  readonly onAccepted?: (
    endpoint: EndpointConfig,
    request: FastifyRequest,
    result: Extract<GateResult, { outcome: 'accepted' }>,
  ) => Promise<void> | void
}

/**
 * A route that verifies and de-duplicates, then hands off.
 *
 * Responses are deliberately terse. Telling a caller *why* their signature
 * failed — malformed, wrong secret, stale — hands an attacker a free oracle,
 * so the detail goes to the log and a flat `unauthorized` goes back.
 */
export function registerWebhookRoute(
  app: FastifyInstance,
  options: WebhookRouteOptions,
): void {
  const path = options.path ?? '/webhooks/:endpointId'

  app.post<{ Params: { endpointId: string } }>(path, async (request, reply) => {
    const endpoint = await options.lookup(request.params.endpointId)
    if (endpoint === null) {
      // 404 regardless of whether the id is well-formed: enumerating valid
      // endpoint ids should not be possible from the outside.
      return reply.code(404).send({ error: 'not_found' })
    }

    if (request.rawBody === undefined) {
      return reply.code(415).send({ error: 'unsupported_media_type' })
    }

    const result = await options.gate(endpoint, {
      rawBody: request.rawBody,
      headers: request.headers,
      method: request.method,
    })

    if (result.status !== 200) {
      request.log.warn(
        { endpointId: endpoint.endpointId, outcome: result.outcome, reason: result.reason },
        'webhook rejected',
      )
      return reply.code(result.status).send({ error: result.outcome })
    }

    if (result.outcome === 'duplicate') {
      // 200 on purpose. A sender retrying because it never saw our response is
      // behaving correctly; a 4xx would make it retry harder and more often.
      return reply.code(200).send({ ok: true, duplicate: true })
    }

    if (options.onAccepted !== undefined) {
      await options.onAccepted(endpoint, request, result)
    }
    return reply.code(200).send({ ok: true, duplicate: false })
  })
}
