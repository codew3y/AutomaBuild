/**
 * The outbound sender.
 *
 * Retries are tested with an injected sleep and a seeded random, so a
 * five-attempt ladder is synchronous and the assertions are on the delays
 * rather than on how long the test took.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { backoffMs, isRetryable, send, signPayload } from '../src/outbound.ts'
import { verifyStandardWebhooks } from '../src/verify/standard-webhooks.ts'

const SECRET = `whsec_${Buffer.from('outbound-secret!').toString('base64')}`
const PAYLOAD = '{"type":"run.finished","runId":"r-1"}'
const NOW = new Date('2026-03-01T12:00:00Z')

describe('signing', () => {
  it('produces headers our own verifier accepts', () => {
    // The round trip is the point: if these two disagree, one of them is wrong
    // and a recipient using an off-the-shelf library would find out first.
    const headers = signPayload({ payload: PAYLOAD, secrets: [SECRET], timestamp: NOW })
    const result = verifyStandardWebhooks({
      rawBody: PAYLOAD,
      headers,
      secrets: [SECRET],
      now: NOW,
    })
    assert.equal(result.ok, true)
    assert.equal(result.dedupKey, headers['webhook-id'])
  })

  it('signs with every active secret so a rotation is not an outage', () => {
    // During a roll the recipient may know only the old secret or only the
    // new one. Both signatures are present, so either verifies.
    const oldSecret = `whsec_${Buffer.from('old-secret-here!').toString('base64')}`
    const newSecret = `whsec_${Buffer.from('new-secret-here!').toString('base64')}`
    const headers = signPayload({
      payload: PAYLOAD,
      secrets: [oldSecret, newSecret],
      timestamp: NOW,
    })

    assert.equal(headers['webhook-signature'].split(' ').length, 2)
    for (const secret of [oldSecret, newSecret]) {
      const result = verifyStandardWebhooks({
        rawBody: PAYLOAD,
        headers,
        secrets: [secret],
        now: NOW,
      })
      assert.equal(result.ok, true, 'a recipient knowing only one secret could not verify')
    }
  })

  it('refuses to sign with no secret', () => {
    assert.throws(() => signPayload({ payload: PAYLOAD, secrets: [] }), RangeError)
  })

  it('gives each message a distinct id', () => {
    const a = signPayload({ payload: PAYLOAD, secrets: [SECRET] })
    const b = signPayload({ payload: PAYLOAD, secrets: [SECRET] })
    assert.notEqual(a['webhook-id'], b['webhook-id'])
  })
})

describe('backoff', () => {
  it('grows exponentially and stops at the cap', () => {
    const ceiling = (attempt: number) =>
      backoffMs(attempt, { baseDelayMs: 1000, capDelayMs: 8000, random: () => 0.999999 })
    assert.deepEqual([1, 2, 3, 4, 5].map(ceiling), [999, 1999, 3999, 7999, 7999])
  })

  it('can return almost nothing, which is the point of full jitter', () => {
    assert.equal(backoffMs(5, { random: () => 0 }), 0)
  })

  it('does not overflow on an absurd attempt number', () => {
    assert.ok(Number.isFinite(backoffMs(5000, { random: () => 0.5 })))
  })
})

describe('what is worth retrying', () => {
  it('retries server errors and explicit not-now responses', () => {
    for (const status of [500, 502, 503, 504, 408, 429]) {
      assert.equal(isRetryable(status), true, `${status} should retry`)
    }
  })

  it('does not retry a refusal', () => {
    // The same request will be refused identically next time. Retrying it four
    // more times helps nobody and looks like an attack from their side.
    for (const status of [400, 401, 403, 404, 410, 422]) {
      assert.equal(isRetryable(status), false, `${status} should not retry`)
    }
  })
})

describe('delivery', () => {
  const noSleep = async () => {}

  it('delivers first time when the recipient is healthy', async () => {
    let calls = 0
    const result = await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      sleep: noSleep,
      fetchImpl: async () => {
        calls++
        return new Response('', { status: 200 })
      },
    })
    assert.equal(result.kind, 'delivered')
    assert.equal(calls, 1)
  })

  it('retries a 503 and succeeds when the recipient recovers', async () => {
    let calls = 0
    const result = await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      sleep: noSleep,
      random: () => 0,
      fetchImpl: async () => {
        calls++
        return new Response('', { status: calls < 3 ? 503 : 200 })
      },
    })
    assert.equal(result.kind, 'delivered')
    assert.equal(calls, 3)
    assert.equal(result.attempts.length, 3)
  })

  it('sends the same message id on every retry', async () => {
    // The property a recipient's deduplication depends on. Re-signing per
    // attempt would give each retry a new id, and they would see three
    // separate events rather than one delivered three times.
    const ids: string[] = []
    await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      sleep: noSleep,
      random: () => 0,
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>
        ids.push(headers['webhook-id']!)
        return new Response('', { status: 503 })
      },
    })
    assert.equal(ids.length, 5)
    assert.equal(new Set(ids).size, 1, 'the message id changed between retries')
  })

  it('keeps the signature valid across retries', async () => {
    // Re-signing would also move the timestamp, and a recipient enforcing a
    // tolerance would reject a retry that arrived after the window closed.
    let captured: Record<string, string> | undefined
    await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      sleep: noSleep,
      random: () => 0,
      now: () => NOW,
      fetchImpl: async (_url, init) => {
        captured = init?.headers as Record<string, string>
        return new Response('', { status: 503 })
      },
    })
    assert.ok(captured)
    const result = verifyStandardWebhooks({
      rawBody: PAYLOAD,
      headers: captured,
      secrets: [SECRET],
      now: NOW,
    })
    assert.equal(result.ok, true)
  })

  it('gives up after the attempt budget and produces a replayable DLQ entry', async () => {
    const result = await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      maxAttempts: 3,
      sleep: noSleep,
      random: () => 0,
      fetchImpl: async () => new Response('', { status: 500 }),
    })

    assert.equal(result.kind, 'exhausted')
    assert.equal(result.attempts.length, 3)
    assert.equal(result.dlq.attempts, 3)
    assert.equal(result.dlq.payload, PAYLOAD)
    // The original headers, so a replay is the same event rather than a new
    // one the recipient has never seen.
    assert.ok(result.dlq.headers['webhook-signature'])
    assert.equal(result.dlq.messageId, result.dlq.headers['webhook-id'])
  })

  it('abandons a 400 immediately rather than spending the budget', async () => {
    let calls = 0
    const result = await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      sleep: noSleep,
      fetchImpl: async () => {
        calls++
        return new Response('', { status: 400 })
      },
    })
    assert.equal(result.kind, 'abandoned')
    assert.equal(calls, 1)
    assert.equal(result.reason, 'HTTP 400')
  })

  it('retries a network failure, not just a bad status', async () => {
    let calls = 0
    const result = await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      sleep: noSleep,
      random: () => 0,
      fetchImpl: async () => {
        calls++
        if (calls < 2) throw new Error('ECONNRESET')
        return new Response('', { status: 200 })
      },
    })
    assert.equal(result.kind, 'delivered')
    assert.equal(calls, 2)
    assert.match(result.attempts[0]!.error ?? '', /ECONNRESET/)
  })

  it('waits between attempts, and the waits grow', async () => {
    const waits: number[] = []
    await send({
      url: 'https://example.test/hook',
      payload: PAYLOAD,
      secrets: [SECRET],
      maxAttempts: 4,
      baseDelayMs: 1000,
      capDelayMs: 60_000,
      random: () => 0.999999,
      sleep: async (ms) => {
        waits.push(ms)
      },
      fetchImpl: async () => new Response('', { status: 503 }),
    })
    assert.deepEqual(waits, [999, 1999, 3999])
  })
})
