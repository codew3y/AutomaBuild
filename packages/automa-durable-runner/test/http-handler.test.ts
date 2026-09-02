/**
 * The HTTP step, against a real server on loopback.
 *
 * `automa-safe-fetch` blocks loopback by design — a flow URL comes from a
 * user, and pointing one at 127.0.0.1 or the metadata endpoint is the SSRF the
 * client exists to stop. The client's own documented escape hatch,
 * `allowedRanges`, is used here and only here: a test fixture is exactly the
 * case it was written for, and the alternative is either testing against the
 * internet or not testing this at all.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createSafeFetch } from 'automa-safe-fetch'

import { httpHandler, StepFailure } from '../src/engine/handlers.ts'
import type { StepContext } from '../src/engine/handlers.ts'

let server: Server
let base: string

/**
 * The response is encoded in the request, not held in a mutable fixture.
 *
 * node:test runs these concurrently, and a shared `reply` variable that each
 * test sets before making its request is read by whichever request happens to
 * land next — which made six of these fail against a perfectly correct
 * handler. Anything the server needs to know arrives in the query string.
 */
let lastRequest: { url: string; method: string; headers: Record<string, unknown> } | null = null

before(async () => {
  server = createServer((request, response) => {
    lastRequest = {
      url: request.url ?? '',
      method: request.method ?? '',
      headers: request.headers as Record<string, unknown>,
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const contentType = url.searchParams.get('type')
    const status = Number(url.searchParams.get('status') ?? 200)

    if (contentType !== null) response.setHeader('content-type', contentType)
    response.statusCode = status
    response.end(url.searchParams.get('body') ?? '{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Build a URL that asks the fixture for a particular response. */
const asking = (params: { type?: string; status?: number; body?: string }): string => {
  const url = new URL(`${base}/echo`)
  if (params.type !== undefined) url.searchParams.set('type', params.type)
  if (params.status !== undefined) url.searchParams.set('status', String(params.status))
  if (params.body !== undefined) url.searchParams.set('body', params.body)
  return url.toString()
}

const handler = () =>
  httpHandler({
    safeFetch: createSafeFetch({
      allowedRanges: ['127.0.0.0/8'],
      allowedPorts: [Number(new URL(base).port)],
      maxRedirects: 0,
    }),
  })

const context = (config: Record<string, unknown>): StepContext =>
  ({
    node: { id: 'call', kind: 'http', idempotent: true, config },
    idempotencyKey: 'idem-1',
    signal: AbortSignal.timeout(10_000),
    deadlineMs: 10_000,
    upstream: {},
    run: {},
    step: {},
  }) as unknown as StepContext

describe('the http step', () => {
  test('a JSON response comes back as data, not as a string to re-parse', async () => {
    // The reason this matters: a later step's mapping is written as
    // `{{ steps.lookup.output.body.full_name }}`, and against a string that
    // path resolves to nothing.
    const result = await handler()(
      context({ url: asking({ type: 'application/json', body: '{"full_name":"nodejs/node"}' }) }),
    )
    const output = result.output as { status: number; body: unknown }

    assert.equal(output.status, 200)
    assert.deepEqual(output.body, { full_name: 'nodejs/node' })
  })

  test('honours a charset on the content type', async () => {
    const result = await handler()(
      context({ url: asking({ type: 'application/json; charset=utf-8', body: '{"ok":true}' }) }),
    )
    assert.deepEqual((result.output as { body: unknown }).body, { ok: true })
  })

  test('recognises a vendor JSON content type', async () => {
    const result = await handler()(
      context({ url: asking({ type: 'application/vnd.api+json', body: '{"ok":true}' }) }),
    )
    assert.deepEqual((result.output as { body: unknown }).body, { ok: true })
  })

  test('anything that is not JSON stays text', async () => {
    const result = await handler()(
      context({ url: asking({ type: 'text/plain', body: 'plain words' }) }),
    )
    assert.equal((result.output as { body: unknown }).body, 'plain words')
  })

  test('a response with no content type at all stays text', async () => {
    const result = await handler()(context({ url: asking({ body: '{"looks":"like json"}' }) }))
    assert.equal(
      (result.output as { body: unknown }).body,
      '{"looks":"like json"}',
      'the content type decides, not a guess at the shape of the bytes',
    )
  })

  test('a body that claims to be JSON and is not keeps the text rather than failing', async () => {
    // Their bug, not ours — and the text is the only evidence of what actually
    // arrived, so losing it would make the failure harder to diagnose.
    const result = await handler()(
      context({ url: asking({ type: 'application/json', body: 'not json at all' }) }),
    )
    assert.equal((result.output as { body: unknown }).body, 'not json at all')
  })

  test('sends the idempotency key, so a provider that honours it can', async () => {
    await handler()(
      context({ url: asking({ type: 'application/json' }), method: 'POST', body: '{}' }),
    )
    assert.equal(lastRequest?.headers['idempotency-key'], 'idem-1')
    assert.equal(lastRequest?.method, 'POST')
  })

  test('a non-2xx is a step failure carrying the status', async () => {
    await assert.rejects(
      () => handler()(context({ url: asking({ status: 503, body: '{"error":"busy"}' }) })),
      (error: unknown) => {
        assert.ok(error instanceof StepFailure)
        assert.equal(error.facts.httpStatus, 503)
        return true
      },
    )
  })

  test('a loopback URL is still blocked by the default client', async () => {
    // The guard on the escape hatch above: without allowedRanges, this is
    // exactly the request the client exists to refuse.
    const strict = httpHandler()
    await assert.rejects(
      () => strict(context({ url: `${base}/x` })),
      (error: unknown) => {
        assert.ok(error instanceof StepFailure)
        assert.match(error.message, /blocked/)
        return true
      },
    )
  })
})
