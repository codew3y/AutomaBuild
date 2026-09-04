/**
 * The gate and the replay store, including a real HTTP round trip.
 *
 * The interesting tests here are the ones about *ordering* — what gets checked
 * before what — because that is where replay protection is quietly undone.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { createGate, type EndpointConfig } from '../src/gate.ts'
import { MemoryReplayStore } from '../src/replay/memory.ts'
import { assertRetentionCoversTolerance } from '../src/replay/store.ts'
import { registerRawBody, registerWebhookRoute } from '../src/fastify.ts'

const SECRET = 'whsec_gate_secret'
const BODY = '{"event":"invoice.paid","amount":2500}'
const NOW = new Date('2026-03-01T12:00:00Z')
const TS = Math.floor(NOW.getTime() / 1000)

const githubSig = (body = BODY, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const stripeSig = (timestamp = TS, body = BODY, secret = SECRET) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

describe('the gate', () => {
  let store: MemoryReplayStore
  let gate: ReturnType<typeof createGate>

  beforeEach(() => {
    store = new MemoryReplayStore()
    gate = createGate({ store })
  })

  const github: EndpointConfig = {
    endpointId: randomUUID(),
    scheme: 'github',
    secrets: [SECRET],
  }
  const stripe: EndpointConfig = {
    endpointId: randomUUID(),
    scheme: 'stripe',
    secrets: [SECRET],
  }

  it('accepts a genuine delivery once', async () => {
    const result = await gate(github, {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': githubSig(), 'x-github-delivery': 'd-1' },
      now: NOW,
    })
    assert.equal(result.status, 200)
    assert.equal(result.outcome, 'accepted')
  })

  it('returns 200 duplicate on a replay, not an error', async () => {
    // A sender retrying because it never saw our response is behaving
    // correctly. A 4xx would make it retry harder.
    const request = {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': githubSig(), 'x-github-delivery': 'd-2' },
      now: NOW,
    }
    const first = await gate(github, request)
    const second = await gate(github, request)

    assert.equal(first.outcome, 'accepted')
    assert.equal(second.status, 200)
    assert.equal(second.outcome, 'duplicate')
    assert.equal(second.originallyAt?.toISOString(), NOW.toISOString())
  })

  it('does not record a delivery whose signature failed', async () => {
    // The attack this prevents: send a forged request claiming a delivery id,
    // and if the rejection were recorded, the genuine delivery arriving
    // moments later would be dismissed as a duplicate and dropped. Replay
    // protection turned into a denial of service.
    const forged = await gate(github, {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-delivery': 'd-3' },
      now: NOW,
    })
    assert.equal(forged.status, 401)
    assert.equal(store.size, 0, 'a rejected request must not occupy a dedup key')

    const genuine = await gate(github, {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': githubSig(), 'x-github-delivery': 'd-3' },
      now: NOW,
    })
    assert.equal(genuine.outcome, 'accepted', 'the real delivery was locked out')
  })

  it('keeps dedup keys separate per endpoint', async () => {
    // Two endpoints can legitimately see the same provider event id.
    const other: EndpointConfig = { ...github, endpointId: randomUUID() }
    const request = {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': githubSig(), 'x-github-delivery': 'shared' },
      now: NOW,
    }
    assert.equal((await gate(github, request)).outcome, 'accepted')
    assert.equal((await gate(other, request)).outcome, 'accepted')
  })

  it('rejects a stale delivery as a timestamp problem, not an auth failure', async () => {
    const stale = TS - 600
    const result = await gate(stripe, {
      rawBody: BODY,
      headers: { 'stripe-signature': stripeSig(stale) },
      now: NOW,
    })
    assert.equal(result.status, 400)
    assert.equal(result.outcome, 'rejected_timestamp')
  })

  it('rejects an oversized body with 413 before hashing it', async () => {
    const huge = 'x'.repeat(4096)
    const result = await gate(
      { ...github, maxBodyBytes: 1024 },
      {
        rawBody: huge,
        headers: { 'x-hub-signature-256': githubSig(huge), 'x-github-delivery': 'big' },
        now: NOW,
      },
    )
    assert.equal(result.status, 413)
    assert.equal(result.outcome, 'rejected_size')
  })

  it('refuses a GET', async () => {
    const result = await gate(github, {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': githubSig(), 'x-github-delivery': 'd' },
      method: 'GET',
      now: NOW,
    })
    assert.equal(result.status, 405)
  })

  it('refuses a retention window shorter than the tolerance', () => {
    // Otherwise there is a gap in which a captured request is still inside its
    // validity window but has already been forgotten.
    assert.throws(() => assertRetentionCoversTolerance(60, 300), RangeError)
    assert.doesNotThrow(() => assertRetentionCoversTolerance(86_400, 300))
  })

  it('checks the signature before touching the store', async () => {
    // Ordering, stated as a test: an unauthenticated request must never be
    // able to write a row, or anyone who can reach the endpoint can fill the
    // table.
    const failing = new (class extends MemoryReplayStore {
      override async record(): Promise<never> {
        throw new Error('the store was consulted before the signature was verified')
      }
    })()

    const strictGate = createGate({ store: failing })
    const result = await strictGate(github, {
      rawBody: BODY,
      headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}`, 'x-github-delivery': 'd' },
      now: NOW,
    })
    assert.equal(result.status, 401)
  })
})

describe('MemoryReplayStore', () => {
  it('prunes by age', async () => {
    const store = new MemoryReplayStore()
    await store.record({
      endpointId: 'e',
      dedupKey: 'old',
      outcome: 'accepted',
      receivedAt: new Date('2026-01-01T00:00:00Z'),
    })
    await store.record({
      endpointId: 'e',
      dedupKey: 'new',
      outcome: 'accepted',
      receivedAt: NOW,
    })
    assert.equal(store.size, 2)

    const removed = await store.prune(new Date('2026-02-01T00:00:00Z'))
    assert.equal(removed, 1)
    assert.equal(store.size, 1)
  })

  it('refuses to be constructed in production', () => {
    // Its failure mode is silent: everything works until a second process
    // starts, and then replay protection quietly does nothing.
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      assert.throws(() => new MemoryReplayStore(), /no replay protection across processes/)
      assert.doesNotThrow(() => new MemoryReplayStore({ allowInProduction: true }))
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
})

describe('over real HTTP', () => {
  let app: FastifyInstance
  let store: MemoryReplayStore
  const endpointId = randomUUID()
  const accepted: string[] = []

  before(async () => {
    store = new MemoryReplayStore()
    app = Fastify({ logger: false })
    await app.register(async (scope) => {
      registerRawBody(scope, { maxBodyBytes: 2048 })
      registerWebhookRoute(scope, {
        gate: createGate({ store }),
        lookup: (id) =>
          id === endpointId
            ? { endpointId, scheme: 'github' as const, secrets: [SECRET] }
            : null,
        onAccepted: (_endpoint, _request, result) => {
          accepted.push(result.dedupKey)
        },
      })
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  const post = (body: string, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/webhooks/${endpointId}`,
      headers: { 'content-type': 'application/json', ...headers },
      payload: body,
    })

  it('accepts a genuine delivery and hands it off exactly once', async () => {
    const headers = { 'x-hub-signature-256': githubSig(), 'x-github-delivery': 'http-1' }
    const first = await post(BODY, headers)
    const second = await post(BODY, headers)

    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.json(), { ok: true, duplicate: false })
    assert.equal(second.statusCode, 200)
    assert.deepEqual(second.json(), { ok: true, duplicate: true })
    assert.equal(accepted.length, 1, 'the handler ran twice for one event')
  })

  it('does not accept a captured delivery again under a new delivery id', () => {
    // The key is derived from the secret and the body, so varying the one
    // header that is not signed no longer mints a fresh key.
    return (async () => {
      // Its own body, because the dedup key is now derived from the body and
      // this suite shares one store — reusing BODY would collide with an
      // earlier test's delivery and the first post would already be a
      // duplicate. That collision is the fix working, but it is not what this
      // test is trying to show.
      const body = '{"event":"invoice.paid","amount":9999}'
      const signature = githubSig(body)
      const first = await post(body, {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'capture-1',
      })
      const replay = await post(body, {
        'x-hub-signature-256': signature,
        'x-github-delivery': 'a-different-id',
      })

      assert.deepEqual(first.json(), { ok: true, duplicate: false })
      assert.deepEqual(replay.json(), { ok: true, duplicate: true })
    })()
  })

  it('verifies against the bytes that arrived, not a re-serialisation', async () => {
    // The whole reason for the raw-body plugin. This body has whitespace that
    // JSON.stringify would remove; if the route verified a re-serialised
    // object the signature would not match.
    const pretty = '{\n  "amount": 1000,\n  "currency": "chf"\n}'
    const response = await post(pretty, {
      'x-hub-signature-256': githubSig(pretty),
      'x-github-delivery': 'http-pretty',
    })
    assert.equal(response.statusCode, 200, 'raw body was not preserved')
  })

  it('rejects a forged signature with 401 and no detail', async () => {
    const response = await post(BODY, {
      'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      'x-github-delivery': 'http-forged',
    })
    assert.equal(response.statusCode, 401)
    // The reason goes to the log, not to the caller: telling an attacker
    // whether their signature was malformed or merely wrong is free
    // information.
    assert.deepEqual(response.json(), { error: 'rejected_signature' })
  })

  it('rejects a body over the limit before assembling it', async () => {
    const huge = `{"pad":"${'x'.repeat(4096)}"}`
    const response = await post(huge, {
      'x-hub-signature-256': githubSig(huge),
      'x-github-delivery': 'http-big',
    })
    assert.equal(response.statusCode, 413)
  })

  it('404s an unknown endpoint without revealing whether the id was well-formed', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/${randomUUID()}`,
      headers: { 'content-type': 'application/json', 'x-github-delivery': 'x' },
      payload: BODY,
    })
    assert.equal(response.statusCode, 404)
  })

  it('authenticates a body that is not valid JSON', async () => {
    // The signature covers bytes. An unparseable body can still be
    // authenticated, and should be judged on its merits rather than dismissed
    // before anyone checks who sent it.
    const notJson = 'this is not json at all'
    const response = await post(notJson, {
      'x-hub-signature-256': githubSig(notJson),
      'x-github-delivery': 'http-notjson',
    })
    assert.equal(response.statusCode, 200)
  })
})
