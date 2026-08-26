/**
 * The retry state machine.
 *
 * Every test here is synchronous and deterministic. No waiting, no real
 * randomness, no clock. A five-attempt ladder spanning half an hour of
 * wall-clock time is asserted in under a millisecond, which is the only way
 * this behaviour gets tested at all rather than being assumed.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INITIAL_RETRY_STATE,
  onAttemptFailed,
  onAttemptStarted,
  simulateLadder,
  type AttemptFailure,
} from '../src/retry.ts'
import { DEFAULT_BACKOFF, type BackoffPolicy } from '../src/backoff.ts'
import { alwaysRandom, seededRandom } from '../src/random.ts'

const IDEMPOTENT: AttemptFailure = { errorClass: 'transient_network', idempotent: true }

describe('the retry ladder', () => {
  it('runs five attempts and then gives up, in one synchronous test', () => {
    // The test the brief asks for: fake clock, seeded jitter, five attempts.
    const { outcomes, finalState } = simulateLadder({
      failures: Array.from({ length: 5 }, () => IDEMPOTENT),
      random: seededRandom(42),
    })

    assert.equal(outcomes.length, 5)
    for (const outcome of outcomes.slice(0, 4)) {
      assert.equal(outcome.kind, 'retry')
    }
    assert.equal(outcomes[4]?.kind, 'exhausted')
    assert.equal(finalState.attemptsConsumed, 5)
    assert.equal(finalState.attemptsStarted, 5)
  })

  it('is reproducible — the same seed gives the same ladder', () => {
    const run = () =>
      simulateLadder({
        failures: Array.from({ length: 4 }, () => IDEMPOTENT),
        random: seededRandom(7),
      }).outcomes.map((o) => (o.kind === 'retry' ? o.delayMs : o.kind))

    assert.deepEqual(run(), run(), 'the same seed must produce the same delays')
  })

  it('stays inside the exponential envelope', () => {
    // Full Jitter draws from [0, window). With random() pinned just below 1
    // the delay approaches the un-jittered window, which is the ceiling.
    const { outcomes } = simulateLadder({
      failures: Array.from({ length: 4 }, () => IDEMPOTENT),
      random: alwaysRandom(0.999999),
    })
    const delays = outcomes.filter((o) => o.kind === 'retry').map((o) => o.delayMs)
    assert.deepEqual(delays, [999, 1999, 3999, 7999])
  })

  it('can return almost immediately — that is the point of drawing from zero', () => {
    const { outcomes, totalDelayMs } = simulateLadder({
      failures: [IDEMPOTENT, IDEMPOTENT],
      random: alwaysRandom(0),
    })
    assert.equal(totalDelayMs, 0)
    assert.equal(outcomes[0]?.kind, 'retry')
  })

  it('respects the cap on long ladders', () => {
    // Ten attempts permitted, ten failures: the first nine retry, the tenth
    // has no budget left. The window doubles until it hits the cap and then
    // stays there — an unbounded ladder would eventually schedule a retry
    // years out and look, from the outside, exactly like a lost run.
    const policy: BackoffPolicy = { baseMs: 1_000, capMs: 5_000, maxAttempts: 10 }
    const { outcomes } = simulateLadder({
      failures: Array.from({ length: 10 }, () => IDEMPOTENT),
      random: alwaysRandom(0.999999),
      policy,
    })
    const delays = outcomes.filter((o) => o.kind === 'retry').map((o) => o.delayMs)
    assert.deepEqual(delays, [999, 1999, 3999, 4999, 4999, 4999, 4999, 4999, 4999])
    for (const delay of delays) assert.ok(delay < policy.capMs)
    assert.equal(outcomes[9]?.kind, 'exhausted')
  })
})

describe('rate limiting does not consume the retry budget', () => {
  it('survives twenty 429s with every attempt intact', () => {
    // The scenario this rule exists for: a provider having a busy afternoon
    // must not be able to exhaust a step that has not actually failed.
    const { outcomes, finalState } = simulateLadder({
      failures: Array.from({ length: 20 }, () => ({
        errorClass: 'rate_limited' as const,
        idempotent: true,
      })),
      random: seededRandom(1),
    })

    assert.equal(outcomes.length, 20, 'none of these should have been terminal')
    assert.ok(outcomes.every((o) => o.kind === 'retry'))
    assert.equal(finalState.attemptsConsumed, 0, 'a 429 must not count as an attempt')
    assert.equal(finalState.attemptsStarted, 20)
  })

  it('keeps the backoff window early when only rate limits have occurred', () => {
    // Window is sized on consumed attempts. Nine rate limits then one real
    // failure is early in the ladder, and must not wait as if it were deep in.
    const failures: AttemptFailure[] = [
      ...Array.from({ length: 9 }, () => ({ errorClass: 'rate_limited' as const, idempotent: true })),
      IDEMPOTENT,
    ]
    const { outcomes } = simulateLadder({ failures, random: alwaysRandom(0.999999) })
    const last = outcomes[9]
    assert.equal(last?.kind, 'retry')
    assert.equal(last.delayMs, 999, 'should use the first-attempt window, not the tenth')
  })

  it('honours Retry-After over its own computation', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'rate_limited', idempotent: true, retryAfterMs: 60_000 },
      { now: 1_000, random: alwaysRandom(0) },
    )
    assert.equal(outcome.kind, 'retry')
    assert.equal(outcome.delayMs, 60_000)
    assert.equal(outcome.delaySource, 'retry_after')
    assert.equal(outcome.nextAttemptAt, 61_000)
  })

  it('never backs off less than the provider asked', () => {
    // Even with jitter drawing high, a longer Retry-After wins.
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'rate_limited', idempotent: true, retryAfterMs: 30_000 },
      { now: 0, random: alwaysRandom(0.999999) },
    )
    assert.equal(outcome.kind, 'retry')
    assert.ok(outcome.delayMs >= 30_000)
  })

  it('clamps an outrageous Retry-After rather than parking a worker for a week', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'rate_limited', idempotent: true, retryAfterMs: 7 * 24 * 3600 * 1000 },
      { now: 0, random: alwaysRandom(0) },
    )
    assert.equal(outcome.kind, 'retry')
    assert.equal(outcome.delayMs, DEFAULT_BACKOFF.capMs)
    assert.equal(outcome.delaySource, 'retry_after_clamped')
  })
})

describe('classes that must never be retried', () => {
  for (const errorClass of ['client_error', 'auth_broken', 'poison'] as const) {
    it(`stops immediately on ${errorClass}`, () => {
      const outcome = onAttemptFailed(
        onAttemptStarted(INITIAL_RETRY_STATE),
        { errorClass, idempotent: true },
        { now: 0, random: seededRandom(1) },
      )
      assert.equal(outcome.kind, 'terminal')
      assert.equal(outcome.state.attemptsConsumed, 0, 'a hopeless failure should not burn budget')
    })
  }

  it('sends poison to the dead-letter queue rather than round the loop', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'poison', idempotent: true },
      { now: 0, random: seededRandom(1) },
    )
    assert.equal(outcome.kind, 'terminal')
    assert.equal(outcome.action, 'dead_letter')
  })

  it('fails the whole run on auth_broken, not just the step', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'auth_broken', idempotent: true },
      { now: 0, random: seededRandom(1) },
    )
    assert.equal(outcome.kind, 'terminal')
    assert.equal(outcome.action, 'fail_run')
  })
})

describe('the ambiguous cases — where duplicates come from', () => {
  it('retries a timeout when the call is safely repeatable', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'timeout', idempotent: true },
      { now: 0, random: alwaysRandom(0.5) },
    )
    assert.equal(outcome.kind, 'retry')
  })

  it('refuses to retry a timeout when the call is not repeatable', () => {
    // The whole point. We do not know whether the effect happened. Retrying is
    // a guess about someone else's system, and the wrong guess sends the money
    // twice — so a human is asked instead.
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'timeout', idempotent: false },
      { now: 0, random: alwaysRandom(0.5) },
    )
    assert.equal(outcome.kind, 'terminal')
    assert.equal(outcome.action, 'pause_for_confirmation')
    assert.match(outcome.reason, /unknown_outcome/)
  })

  it('applies the same rule to a 500 on a non-idempotent call', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'server_error', idempotent: false },
      { now: 0, random: alwaysRandom(0.5) },
    )
    assert.equal(outcome.kind, 'terminal')
    assert.equal(outcome.action, 'pause_for_confirmation')
  })

  it('does not burn an attempt when escalating to unknown_outcome', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      { errorClass: 'server_error', idempotent: false },
      { now: 0, random: alwaysRandom(0.5) },
    )
    assert.equal(outcome.state.attemptsConsumed, 0)
  })
})

describe('exhaustion', () => {
  it('reports exhausted rather than terminal, so the step reaches the DLQ', () => {
    const policy: BackoffPolicy = { ...DEFAULT_BACKOFF, maxAttempts: 2 }
    const { outcomes } = simulateLadder({
      failures: [IDEMPOTENT, IDEMPOTENT],
      random: seededRandom(3),
      policy,
    })
    assert.equal(outcomes[0]?.kind, 'retry')
    assert.equal(outcomes[1]?.kind, 'exhausted')
    assert.match(outcomes[1].reason, /all 2 attempts consumed/)
  })

  it('a single-attempt policy exhausts on the first failure', () => {
    const outcome = onAttemptFailed(
      onAttemptStarted(INITIAL_RETRY_STATE),
      IDEMPOTENT,
      { now: 0, random: seededRandom(1), policy: { ...DEFAULT_BACKOFF, maxAttempts: 1 } },
    )
    assert.equal(outcome.kind, 'exhausted')
  })
})
