/**
 * The rest of the pure core: clock, idempotency, classification, timeouts.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, SystemClock } from '../src/clock.ts'
import { alwaysRandom, seededRandom, systemRandom } from '../src/random.ts'
import { replayKey, stepIdempotencyKey, triggerDedupKey } from '../src/idempotency.ts'
import { classify, parseRetryAfter } from '../src/classify.ts'
import { ERROR_CLASSES, decideRetry, isTerminal, specFor } from '../src/error-classes.ts'
import {
  DEFAULT_TIMEOUTS,
  TimeoutConfigError,
  assertTimeoutsValid,
  remainingCallBudgetMs,
} from '../src/timeouts.ts'

describe('FakeClock', () => {
  it('resolves a 30-day sleep instantly', async () => {
    const clock = new FakeClock(0)
    let woke = false
    const sleeping = clock.sleep(30 * 24 * 3600 * 1000).then(() => {
      woke = true
    })
    assert.equal(woke, false, 'must not resolve before the clock moves')
    await clock.advance(30 * 24 * 3600 * 1000)
    await sleeping
    assert.equal(woke, true)
    assert.equal(clock.now(), 2_592_000_000)
  })

  it('does not wake a sleeper early', async () => {
    const clock = new FakeClock(0)
    let woke = false
    void clock.sleep(1000).then(() => {
      woke = true
    })
    await clock.advance(999)
    assert.equal(woke, false)
    await clock.advance(1)
    await Promise.resolve()
    assert.equal(woke, true)
  })

  it('shows an intermediate time to code that sleeps again on waking', async () => {
    // A retry loop measures each delay against the clock as it resumes. If
    // advance() jumped straight to the end, every delay after the first would
    // be computed from the wrong instant.
    const clock = new FakeClock(0)
    const seen: number[] = []
    const loop = (async () => {
      for (let i = 0; i < 3; i++) {
        await clock.sleep(100)
        seen.push(clock.now())
      }
    })()
    await clock.advance(300)
    await loop
    assert.deepEqual(seen, [100, 200, 300])
  })

  it('does not strand a sleeper that does real async work before sleeping again', async () => {
    // Regression. Yielding a couple of microtasks between wakes is not enough:
    // a worker that wakes, awaits a database round trip, then sleeps again
    // registers its next sleep only after a macrotask. The clock used to
    // conclude nothing was pending, jump to the target, and strand it forever
    // — the fake clock failing on precisely the shape it exists to test.
    const clock = new FakeClock(0)
    let finished = false
    const worker = (async () => {
      await clock.sleep(100)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await clock.sleep(100)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await clock.sleep(100)
      finished = true
    })()

    await clock.advance(300)
    await Promise.race([
      worker,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stranded')), 500)),
    ])
    assert.equal(finished, true)
    assert.equal(clock.now(), 300)
  })

  it('wakes same-instant sleepers in the order they parked', async () => {
    const clock = new FakeClock(0)
    const order: number[] = []
    void clock.sleep(50).then(() => order.push(1))
    void clock.sleep(50).then(() => order.push(2))
    void clock.sleep(50).then(() => order.push(3))
    await clock.advance(50)
    assert.deepEqual(order, [1, 2, 3])
  })

  it('reports what it is waiting for', async () => {
    const clock = new FakeClock(1000)
    void clock.sleep(500)
    void clock.sleep(200)
    assert.equal(clock.pendingSleeps, 2)
    assert.equal(clock.nextDeadline(), 1200)
    assert.equal(await clock.advanceToNextDeadline(), true)
    assert.equal(clock.now(), 1200)
  })

  it('SystemClock reports real time', () => {
    const before = Date.now()
    const now = new SystemClock().now()
    assert.ok(now >= before && now <= Date.now() + 1000)
  })
})

describe('seeded randomness', () => {
  it('is reproducible', () => {
    const draw = (seed: number) => Array.from({ length: 5 }, seededRandom(seed))
    assert.deepEqual(draw(99), draw(99))
    assert.notDeepEqual(draw(99), draw(100))
  })

  it('stays in [0, 1)', () => {
    const random = seededRandom(12345)
    for (let i = 0; i < 1000; i++) {
      const value = random()
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
    }
  })

  it('systemRandom satisfies the same contract', () => {
    const value = systemRandom()
    assert.ok(value >= 0 && value < 1)
  })

  it('alwaysRandom rejects a value it could never legitimately return', () => {
    assert.throws(() => alwaysRandom(1), RangeError)
    assert.throws(() => alwaysRandom(-0.1), RangeError)
  })
})

describe('idempotency keys', () => {
  const identity = { runId: 'run-1', nodeId: 'node-a', iterationIndex: 0, attemptGroup: 0 }

  it('is stable across automatic retries — the whole point', () => {
    assert.equal(stepIdempotencyKey(identity), stepIdempotencyKey({ ...identity }))
  })

  it('changes on a deliberate replay', () => {
    const replay = replayKey(identity)
    assert.notEqual(replay.key, stepIdempotencyKey(identity))
    assert.equal(replay.identity.attemptGroup, 1)
  })

  it('distinguishes every component', () => {
    const keys = new Set([
      stepIdempotencyKey(identity),
      stepIdempotencyKey({ ...identity, runId: 'run-2' }),
      stepIdempotencyKey({ ...identity, nodeId: 'node-b' }),
      stepIdempotencyKey({ ...identity, iterationIndex: 1 }),
      stepIdempotencyKey({ ...identity, attemptGroup: 1 }),
    ])
    assert.equal(keys.size, 5, 'two different steps produced the same key')
  })

  it('cannot be confused by component boundaries', () => {
    // Without a separator that cannot occur in the inputs, ('a-b','c') and
    // ('a','b-c') would hash identically — one step silently deduplicating
    // against a different one.
    assert.notEqual(
      stepIdempotencyKey({ ...identity, runId: 'a-b', nodeId: 'c' }),
      stepIdempotencyKey({ ...identity, runId: 'a', nodeId: 'b-c' }),
    )
  })

  it('rejects input that would break the separator guarantee', () => {
    assert.throws(() => stepIdempotencyKey({ ...identity, runId: 'a\0b' }), RangeError)
    assert.throws(() => stepIdempotencyKey({ ...identity, runId: '' }), RangeError)
    assert.throws(() => stepIdempotencyKey({ ...identity, iterationIndex: -1 }), RangeError)
    assert.throws(() => stepIdempotencyKey({ ...identity, attemptGroup: 1.5 }), RangeError)
  })

  it('prefers the provider event id for trigger dedup', () => {
    const byId = triggerDedupKey({ endpointId: 'e1', providerEventId: 'evt_123', body: 'one' })
    const sameIdOtherBody = triggerDedupKey({
      endpointId: 'e1',
      providerEventId: 'evt_123',
      body: 'two',
    })
    assert.equal(byId, sameIdOtherBody, 'the provider event id should decide, not the body')

    const byBody = triggerDedupKey({ endpointId: 'e1', body: 'one' })
    assert.notEqual(byId, byBody)
  })
})

describe('classification', () => {
  it('maps status codes to the right class', () => {
    assert.equal(classify({ httpStatus: 429 }), 'rate_limited')
    assert.equal(classify({ httpStatus: 401 }), 'auth_expired')
    assert.equal(classify({ httpStatus: 401, refreshAlreadyAttempted: true }), 'auth_broken')
    assert.equal(classify({ httpStatus: 404 }), 'client_error')
    assert.equal(classify({ httpStatus: 422 }), 'client_error')
    assert.equal(classify({ httpStatus: 503 }), 'server_error')
    assert.equal(classify({ httpStatus: 408 }), 'timeout')
  })

  it('separates a socket that never connected from one that died mid-flight', () => {
    // The distinction most engines miss, and the reason people get charged
    // twice: a reset before the request went out is safe to retry; a reset
    // after it went out is ambiguous.
    assert.equal(classify({ code: 'ECONNRESET' }), 'transient_network')
    assert.equal(classify({ code: 'ECONNRESET', requestSent: true }), 'timeout')
    assert.equal(
      classify({ code: 'ECONNRESET', requestSent: true, responseReceived: true }),
      'transient_network',
    )
  })

  it('treats deterministic breakage as poison regardless of anything else', () => {
    assert.equal(classify({ deterministicallyBroken: true, httpStatus: 500 }), 'poison')
  })

  it('does not assume an unrecognised failure is safe', () => {
    assert.equal(classify({ code: 'SOMETHING_NEW' }), 'internal')
    assert.equal(classify({}), 'internal')
  })

  it('parses Retry-After in both RFC 9110 forms', () => {
    assert.equal(parseRetryAfter('120', 0), 120_000)
    assert.equal(parseRetryAfter(undefined, 0), null)
    assert.equal(parseRetryAfter('not a date', 0), null)

    const now = Date.parse('2026-08-25T12:00:00Z')
    assert.equal(parseRetryAfter('Tue, 25 Aug 2026 12:01:00 GMT', now), 60_000)
    // A date already past means "now", never a negative delay.
    assert.equal(parseRetryAfter('Tue, 25 Aug 2026 11:00:00 GMT', now), 0)
  })
})

describe('the classification table itself', () => {
  it('covers all ten classes', () => {
    assert.equal(ERROR_CLASSES.length, 10)
  })

  it('never lets a non-retryable class consume an attempt', () => {
    // Burning budget on something that can never succeed is pure waste, and
    // makes the attempt count lie about what was tried.
    for (const errorClass of ERROR_CLASSES) {
      const spec = specFor(errorClass)
      if (spec.retryable === 'no') {
        assert.equal(spec.consumesAttempt, false, `${errorClass} must not consume an attempt`)
      }
    }
  })

  it('keeps rate limiting free of the attempt budget', () => {
    assert.equal(specFor('rate_limited').retryable, 'yes')
    assert.equal(specFor('rate_limited').consumesAttempt, false)
  })

  it('alerts on every class that means something is actually wrong', () => {
    for (const errorClass of ['auth_broken', 'unknown_outcome', 'internal', 'poison'] as const) {
      assert.equal(specFor(errorClass).alerts, true, `${errorClass} should alert`)
    }
    for (const errorClass of ['rate_limited', 'client_error', 'transient_network'] as const) {
      assert.equal(specFor(errorClass).alerts, false, `${errorClass} should not page anyone`)
    }
  })

  it('treats a paused run as recoverable, not terminal', () => {
    assert.equal(isTerminal('unknown_outcome'), false, 'a human can still resolve this')
    assert.equal(isTerminal('client_error'), true)
    assert.equal(isTerminal('auth_broken'), true)
    assert.equal(isTerminal('poison'), true)
    assert.equal(isTerminal('transient_network'), false)
  })

  it('resolves both conditional classes on idempotency', () => {
    for (const errorClass of ['server_error', 'timeout'] as const) {
      assert.equal(decideRetry(errorClass, { idempotent: true }).retry, true)
      assert.equal(decideRetry(errorClass, { idempotent: false }).retry, false)
      assert.equal(
        decideRetry(errorClass, { idempotent: false }).action,
        'pause_for_confirmation',
      )
    }
  })

  it('rejects a class that came from somewhere untrusted', () => {
    assert.throws(() => specFor('not_a_class' as never), RangeError)
  })
})

/** assert.throws returns undefined, so capture the error when we need to read it. */
function captureThrow(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  assert.fail('expected the call to throw, but it returned normally')
}

describe('timeout layering', () => {
  it('accepts the defaults', () => {
    assert.doesNotThrow(() => assertTimeoutsValid(DEFAULT_TIMEOUTS))
  })

  it('refuses a call timeout that outlives its step', () => {
    assert.throws(
      () => assertTimeoutsValid({ ...DEFAULT_TIMEOUTS, httpCallMs: 60_000, stepAttemptMs: 60_000 }),
      TimeoutConfigError,
    )
  })

  it('refuses a step that can consume the whole run', () => {
    assert.throws(
      () => assertTimeoutsValid({ ...DEFAULT_TIMEOUTS, stepAttemptMs: 300_000, runMs: 300_000 }),
      TimeoutConfigError,
    )
  })

  it('refuses a drain shorter than a step — the inversion that breaks deploys', () => {
    const error = captureThrow(() =>
      assertTimeoutsValid({ ...DEFAULT_TIMEOUTS, stepAttemptMs: 120_000, drainMs: 90_000 }),
    )
    assert.ok(error instanceof TimeoutConfigError)
    assert.ok(error.violations.some((v) => v.includes('drainMs')))
  })

  it('refuses a grace period shorter than the drain', () => {
    assert.throws(
      () => assertTimeoutsValid({ ...DEFAULT_TIMEOUTS, drainMs: 120_000, graceMs: 120_000 }),
      TimeoutConfigError,
    )
  })

  it('enforces the documented ceilings', () => {
    assert.throws(
      () => assertTimeoutsValid({ ...DEFAULT_TIMEOUTS, httpCallMs: 121_000 }),
      TimeoutConfigError,
    )
  })

  it('reports every violation at once rather than one per restart', () => {
    const error = captureThrow(() =>
      assertTimeoutsValid({
        ...DEFAULT_TIMEOUTS,
        httpCallMs: 200_000,
        stepAttemptMs: 400_000,
      }),
    )
    assert.ok(error instanceof TimeoutConfigError)
    assert.ok(error.violations.length >= 2, 'should not stop at the first problem')
  })

  it('shrinks the call budget as the step deadline approaches', () => {
    // Handing a 30-second timeout to a call when only 5 seconds of the step
    // budget remain manufactures an unknown_outcome out of our own arithmetic.
    assert.equal(remainingCallBudgetMs(0, 0, DEFAULT_TIMEOUTS), 30_000)
    assert.equal(remainingCallBudgetMs(55_000, 0, DEFAULT_TIMEOUTS), 5_000)
    assert.equal(remainingCallBudgetMs(60_000, 0, DEFAULT_TIMEOUTS), 0)
    assert.equal(remainingCallBudgetMs(99_000, 0, DEFAULT_TIMEOUTS), 0, 'never negative')
  })
})
