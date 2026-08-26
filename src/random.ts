/**
 * Randomness, as a dependency.
 *
 * Jitter is the whole point of the retry strategy — it is what stops a
 * thousand steps that failed together from retrying together. It is also,
 * naively implemented, what makes a retry test flaky: assert on a delay drawn
 * from `Math.random()` and the suite fails one run in twenty.
 *
 * So the engine never calls `Math.random()`. Production passes `systemRandom`;
 * tests pass a seeded generator and get the same "random" ladder every time.
 */

/** Returns a float in [0, 1). Same contract as `Math.random`. */
export type Random = () => number

export const systemRandom: Random = Math.random

/**
 * mulberry32 — small, fast, and good enough for jitter.
 *
 * Explicitly not for anything security-bearing. Idempotency keys use SHA-256
 * (see `idempotency.ts`); this is only ever used to smear retry timings.
 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A generator that always returns the same value.
 *
 * `alwaysRandom(1)` makes Full Jitter degenerate to plain exponential backoff,
 * which is how the tests assert the *ceiling* of the ladder; `alwaysRandom(0)`
 * asserts the floor.
 */
export function alwaysRandom(value: number): Random {
  if (value < 0 || value >= 1) {
    throw new RangeError(`A random value must be in [0, 1), got ${value}`)
  }
  return () => value
}
