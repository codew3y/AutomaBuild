/**
 * The backoff primitives, separately from the state machine that uses them.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BACKOFF,
  assertPolicyValid,
  attemptsRemaining,
  backoffWindowMs,
  computeRetryDelay,
  worstCaseLadderMs,
  type BackoffPolicy,
} from '../src/backoff.ts'
import { alwaysRandom, seededRandom } from '../src/random.ts'

describe('backoffWindowMs', () => {
  it('doubles from the base and stops at the cap', () => {
    const windows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((a) =>
      backoffWindowMs(a, DEFAULT_BACKOFF),
    )
    assert.deepEqual(
      windows,
      [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000, 900_000],
    )
  })

  it('does not overflow into Infinity on an absurd attempt number', () => {
    // 2 ** 1024 is Infinity, and Math.min(cap, Infinity) returning the cap is
    // the right answer for the wrong reason. Clamp the exponent instead.
    const window = backoffWindowMs(5_000, DEFAULT_BACKOFF)
    assert.ok(Number.isFinite(window))
    assert.equal(window, DEFAULT_BACKOFF.capMs)
  })

  it('rejects a zeroth attempt', () => {
    assert.throws(() => backoffWindowMs(0, DEFAULT_BACKOFF), RangeError)
  })
})

describe('computeRetryDelay', () => {
  it('draws from [0, window) — never the full window', () => {
    const random = seededRandom(2024)
    for (let attempt = 1; attempt <= 6; attempt++) {
      const window = backoffWindowMs(attempt, DEFAULT_BACKOFF)
      for (let i = 0; i < 50; i++) {
        const { delayMs } = computeRetryDelay({ attempt, policy: DEFAULT_BACKOFF, random })
        assert.ok(delayMs >= 0 && delayMs < window, `${delayMs} outside [0, ${window})`)
      }
    }
  })

  it('ignores a Retry-After shorter than the jittered delay', () => {
    // The provider asking for less than we intended to wait is not a licence
    // to hammer it sooner.
    const { delayMs, source } = computeRetryDelay({
      attempt: 4,
      policy: DEFAULT_BACKOFF,
      random: alwaysRandom(0.999999),
      retryAfterMs: 10,
    })
    assert.equal(source, 'jitter')
    assert.equal(delayMs, 7_999)
  })

  it('ignores a nonsensical Retry-After', () => {
    for (const retryAfterMs of [0, -5, null, undefined]) {
      const { source } = computeRetryDelay({
        attempt: 1,
        policy: DEFAULT_BACKOFF,
        random: alwaysRandom(0.5),
        retryAfterMs,
      })
      assert.equal(source, 'jitter')
    }
  })
})

describe('attemptsRemaining', () => {
  it('counts down and floors at zero', () => {
    assert.equal(attemptsRemaining(0, DEFAULT_BACKOFF), 5)
    assert.equal(attemptsRemaining(4, DEFAULT_BACKOFF), 1)
    assert.equal(attemptsRemaining(5, DEFAULT_BACKOFF), 0)
    assert.equal(attemptsRemaining(99, DEFAULT_BACKOFF), 0, 'never negative')
  })
})

describe('worstCaseLadderMs', () => {
  it('sums the un-jittered ladder', () => {
    // Four waits between five attempts: 1s + 2s + 4s + 8s.
    assert.equal(worstCaseLadderMs(DEFAULT_BACKOFF), 15_000)
  })

  it('describes a window a user could actually be told about', () => {
    // The default ladder should resolve in minutes, not hours. A run that sits
    // "retrying" for half a day reads as broken, whatever the UI says.
    assert.ok(worstCaseLadderMs(DEFAULT_BACKOFF) < 30 * 60 * 1000)
  })

  it('is zero when only one attempt is allowed', () => {
    assert.equal(worstCaseLadderMs({ ...DEFAULT_BACKOFF, maxAttempts: 1 }), 0)
  })
})

describe('assertPolicyValid', () => {
  it('accepts the default', () => {
    assert.doesNotThrow(() => assertPolicyValid(DEFAULT_BACKOFF))
  })

  it('rejects policies that cannot mean anything', () => {
    const bad: Array<Partial<BackoffPolicy>> = [
      { baseMs: 0 },
      { baseMs: -1 },
      { capMs: 500 }, // below baseMs
      { maxAttempts: 0 },
    ]
    for (const override of bad) {
      assert.throws(
        () => assertPolicyValid({ ...DEFAULT_BACKOFF, ...override }),
        RangeError,
        `${JSON.stringify(override)} should have been rejected`,
      )
    }
  })
})
