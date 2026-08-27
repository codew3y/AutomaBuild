/**
 * Who may use the control API.
 *
 * The gap this closes was real and was found by accident: a bare `curl -X POST
 * /api/flows/published` with no credentials returned 201 and replaced the live
 * flow. The server was also binding 0.0.0.0, so that was reachable from
 * anything on the same network.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'

import { API_KEY_HEADER, registerApiAuth, resolveApiKey, secretMatches } from '../src/auth.ts'

const KEY = 'sk_test_correct_horse'

async function harness(apiKey: string | null) {
  const app = Fastify({ logger: false })
  registerApiAuth(app, { apiKey })

  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/runs', async () => ({ runs: [] }))
  app.post('/api/flows/published', async () => ({ published: true }))
  app.post('/webhooks/:id', async () => ({ ok: true }))
  app.get('/', async () => 'the canvas')
  app.get('/assets/app.js', async () => 'bundle')

  await app.ready()
  return app
}

describe('the control API', () => {
  test('refuses a publish with no key', async () => {
    const app = await harness(KEY)
    const response = await app.inject({ method: 'POST', url: '/api/flows/published' })
    assert.equal(response.statusCode, 401)
    await app.close()
  })

  test('refuses a publish with the wrong key', async () => {
    const app = await harness(KEY)
    const response = await app.inject({
      method: 'POST',
      url: '/api/flows/published',
      headers: { [API_KEY_HEADER]: 'sk_test_wrong' },
    })
    assert.equal(response.statusCode, 401)
    await app.close()
  })

  test('accepts the right key', async () => {
    const app = await harness(KEY)
    const response = await app.inject({
      method: 'POST',
      url: '/api/flows/published',
      headers: { [API_KEY_HEADER]: KEY },
    })
    assert.equal(response.statusCode, 200)
    await app.close()
  })

  test('protects reading run history too, because a run carries the payload', async () => {
    const app = await harness(KEY)
    assert.equal((await app.inject({ method: 'GET', url: '/api/runs' })).statusCode, 401)
    await app.close()
  })

  test('says nothing about which half was wrong', async () => {
    // Distinguishing "no header" from "wrong value" tells an attacker which
    // half to work on.
    const app = await harness(KEY)
    const missing = await app.inject({ method: 'POST', url: '/api/flows/published' })
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/flows/published',
      headers: { [API_KEY_HEADER]: 'nope' },
    })
    assert.equal(missing.body, wrong.body)
    await app.close()
  })

  describe('what stays open', () => {
    test('the webhook route, which authenticates by signature already', async () => {
      const app = await harness(KEY)
      const response = await app.inject({ method: 'POST', url: '/webhooks/abc' })
      assert.equal(response.statusCode, 200)
      await app.close()
    })

    test('health, so a load balancer needs no credential', async () => {
      const app = await harness(KEY)
      assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200)
      await app.close()
    })

    test('the canvas and its assets, which load before anyone can type a key', async () => {
      const app = await harness(KEY)
      assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200)
      assert.equal((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode, 200)
      await app.close()
    })

    test('a query string does not smuggle a path past the check', async () => {
      const app = await harness(KEY)
      const response = await app.inject({ method: 'GET', url: '/api/runs?x=/api/health' })
      assert.equal(response.statusCode, 401)
      await app.close()
    })
  })

  test('with no key configured, everything is open — which is why it is loopback-only', async () => {
    const app = await harness(null)
    assert.equal((await app.inject({ method: 'POST', url: '/api/flows/published' })).statusCode, 200)
    await app.close()
  })
})

describe('deciding whether a key is required', () => {
  test('loopback may run without one', () => {
    assert.equal(resolveApiKey({}, '127.0.0.1'), null)
    assert.equal(resolveApiKey({}, 'localhost'), null)
    assert.equal(resolveApiKey({}, '::1'), null)
  })

  test('anything else refuses to start rather than coming up open', () => {
    // A warning would scroll past and the thing would be exposed anyway.
    assert.throws(() => resolveApiKey({}, '0.0.0.0'), /Refusing to listen/)
    assert.throws(() => resolveApiKey({}, '192.168.1.10'), /Refusing to listen/)
  })

  test('a key satisfies any bind address', () => {
    assert.equal(resolveApiKey({ API_KEY: 'sk_x' }, '0.0.0.0'), 'sk_x')
  })

  test('an empty key is the same as none, not a key of length zero', () => {
    assert.throws(() => resolveApiKey({ API_KEY: '' }, '0.0.0.0'), /Refusing to listen/)
  })
})

describe('comparing the secret', () => {
  test('matches only an exact value', () => {
    assert.equal(secretMatches('abc', 'abc'), true)
    assert.equal(secretMatches('abd', 'abc'), false)
  })

  test('a length mismatch is false rather than a thrown exception', () => {
    // timingSafeEqual throws on differing lengths, which would leak length
    // through the exception rather than returning an answer.
    assert.equal(secretMatches('short', 'much longer secret'), false)
    assert.equal(secretMatches('', 'x'), false)
  })

  test('a prefix of the real key does not match', () => {
    assert.equal(secretMatches('sk_test', 'sk_test_correct_horse'), false)
  })
})
