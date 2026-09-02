/**
 * What happens when the handoff fails.
 *
 * The record is written before `onAccepted` runs — that ordering is what stops
 * two simultaneous copies of a replayed request both being accepted, and it is
 * not negotiable. The consequence is that a failed handoff leaves a record
 * behind, and the sender's retry is then answered "duplicate".
 *
 * That is the worst outcome this library can produce: a delivery that was
 * verified, acknowledged as new, never acted on, and never offered again.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'

import { MemoryReplayStore, createGate, type ReplayStore } from '../src/index.ts'
import { registerRawBody, registerWebhookRoute } from '../src/fastify.ts'

const SECRET = 'whsec_test'
const ENDPOINT_ID = '00000000-0000-4000-8000-0000000000e1'

function signed(payload: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex')
  return { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` }
}

interface Harness {
  readonly app: FastifyInstance
  readonly store: MemoryReplayStore
  deliver(payload: string, headers: Record<string, string>): Promise<{ status: number; body: string }>
}

function harness(options: {
  onAccepted: () => Promise<void> | void
  passStore?: boolean
}): Harness {
  const store = new MemoryReplayStore()
  const app = Fastify({ logger: false })
  registerRawBody(app)

  registerWebhookRoute(app, {
    path: '/w/:endpointId',
    gate: createGate({ store }),
    lookup: () => ({ endpointId: ENDPOINT_ID, scheme: 'stripe', secrets: [SECRET] }),
    onAccepted: async () => options.onAccepted(),
    ...(options.passStore === false ? {} : { store }),
  })

  return {
    app,
    store,
    async deliver(payload, headers) {
      const response = await app.inject({
        method: 'POST',
        url: `/w/${ENDPOINT_ID}`,
        headers,
        payload,
      })
      return { status: response.statusCode, body: response.body }
    },
  }
}

describe('a handoff that fails', () => {
  test('is offered again on retry rather than dismissed as a duplicate', async () => {
    let attempts = 0
    let handled = 0
    const h = harness({
      onAccepted: () => {
        attempts++
        // The database is down for the first attempt only.
        if (attempts === 1) throw new Error('database unavailable')
        handled++
      },
    })

    const payload = JSON.stringify({ id: 'evt_1' })
    const headers = signed(payload)

    const first = await h.deliver(payload, headers)
    assert.equal(first.status, 500, 'the caller must be told the handoff failed')

    // The sender never saw a 200, so it re-delivers exactly the same request.
    const retry = await h.deliver(payload, headers)
    assert.equal(retry.status, 200)
    assert.match(retry.body, /"duplicate":false/, 'the retry must be treated as new, not as a duplicate')

    assert.equal(attempts, 2)
    assert.equal(handled, 1, 'the delivery must be handed off exactly once, eventually')
    await h.app.close()
  })

  test('leaves nothing behind in the store', async () => {
    const h = harness({
      onAccepted: () => {
        throw new Error('nope')
      },
    })
    const payload = JSON.stringify({ id: 'evt_2' })
    await h.deliver(payload, signed(payload))
    assert.equal(h.store.size, 0, 'a released record must not linger')
    await h.app.close()
  })

  test('a successful handoff still leaves the record, so a real replay is caught', async () => {
    // The guard on the fix: releasing on failure must not turn into releasing
    // on success, which would remove replay protection entirely.
    let handled = 0
    const h = harness({ onAccepted: () => void handled++ })

    const payload = JSON.stringify({ id: 'evt_3' })
    const headers = signed(payload)

    const first = await h.deliver(payload, headers)
    assert.match(first.body, /"duplicate":false/)

    const replayed = await h.deliver(payload, headers)
    assert.match(replayed.body, /"duplicate":true/)

    assert.equal(handled, 1, 'a replayed request must not be handed off a second time')
    assert.equal(h.store.size, 1)
    await h.app.close()
  })

  test('without a store the delivery is still lost, and that is what the log says', async () => {
    // Not a supported configuration, but it must fail loudly rather than
    // pretending. Anyone reading this test learns that `store` is required
    // alongside `onAccepted`.
    let attempts = 0
    const h = harness({
      onAccepted: () => {
        attempts++
        if (attempts === 1) throw new Error('database unavailable')
      },
      passStore: false,
    })

    const payload = JSON.stringify({ id: 'evt_4' })
    const headers = signed(payload)

    await h.deliver(payload, headers)
    const retry = await h.deliver(payload, headers)
    assert.match(retry.body, /"duplicate":true/, 'this is the bug the store parameter exists to fix')
    await h.app.close()
  })
})

describe('releasing a record', () => {
  test('is safe to call for a key that was never recorded', async () => {
    const store: ReplayStore = new MemoryReplayStore()
    await store.release(ENDPOINT_ID, 'never-seen')
    assert.equal((store as MemoryReplayStore).size, 0)
  })

  test('only forgets the key it was given', async () => {
    const store = new MemoryReplayStore()
    const at = new Date()
    await store.record({ endpointId: ENDPOINT_ID, dedupKey: 'a', outcome: 'accepted', receivedAt: at })
    await store.record({ endpointId: ENDPOINT_ID, dedupKey: 'b', outcome: 'accepted', receivedAt: at })

    await store.release(ENDPOINT_ID, 'a')

    assert.equal(store.size, 1)
    const b = await store.record({
      endpointId: ENDPOINT_ID,
      dedupKey: 'b',
      outcome: 'accepted',
      receivedAt: at,
    })
    assert.equal(b.first, false, 'the key that was not released must still be remembered')
  })

  test('a key from one endpoint is not released by the same key on another', async () => {
    const store = new MemoryReplayStore()
    const other = '00000000-0000-4000-8000-0000000000e2'
    const at = new Date()
    await store.record({ endpointId: ENDPOINT_ID, dedupKey: 'k', outcome: 'accepted', receivedAt: at })
    await store.record({ endpointId: other, dedupKey: 'k', outcome: 'accepted', receivedAt: at })

    await store.release(other, 'k')

    const mine = await store.record({
      endpointId: ENDPOINT_ID,
      dedupKey: 'k',
      outcome: 'accepted',
      receivedAt: at,
    })
    assert.equal(mine.first, false, 'the two endpoints must not share a key space')
  })
})
