/**
 * Time, as a dependency.
 *
 * Nothing in this engine may call `Date.now()` directly. Two reasons, and the
 * second is the one that bites:
 *
 * 1. A retry ladder with a 15-minute cap takes half an hour to observe in real
 *    time. Injected, it takes a millisecond, and the test is deterministic
 *    rather than merely fast.
 *
 * 2. In production there must be exactly one clock, and it is Postgres's.
 *    Delayed jobs are scored by absolute timestamps written by whichever node
 *    produced them; if two nodes disagree about the time, work fires early,
 *    late, or twice. Every `wake_at` and `lease_expires_at` is computed from
 *    the database's `now()`, never from a Node process clock. `SystemClock`
 *    exists for tests and for code that genuinely has no transaction to hand.
 */

/** Milliseconds since the Unix epoch. */
export type Millis = number

export interface Clock {
  now(): Millis
  /**
   * Resolves after `ms` of *this clock's* time.
   *
   * Under `FakeClock` this does not resolve until the clock is advanced past
   * the deadline, which is what makes a sleeping worker testable.
   */
  sleep(ms: number): Promise<void>
}

export class SystemClock implements Clock {
  now(): Millis {
    return Date.now()
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      // A pending sleep must not hold the process open during shutdown.
      timer.unref?.()
    })
  }
}

interface PendingSleep {
  readonly dueAt: Millis
  readonly resolve: () => void
  /** Tie-break so sleeps scheduled for the same instant wake in FIFO order. */
  readonly sequence: number
}

/**
 * A clock that only moves when told to.
 *
 * `advance` wakes every sleeper whose deadline has passed, in deadline order,
 * and steps the clock to each deadline as it goes — so a sleeper that schedules
 * another sleep on waking sees the correct intermediate time rather than the
 * final one. Without that, a retry loop under test measures its own delays
 * against a clock that has already jumped to the end.
 */
export class FakeClock implements Clock {
  #now: Millis
  #pending: PendingSleep[] = []
  #sequence = 0

  constructor(startAt: Millis | Date = 0) {
    this.#now = startAt instanceof Date ? startAt.getTime() : startAt
  }

  now(): Millis {
    return this.#now
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.#pending.push({ dueAt: this.#now + ms, resolve, sequence: this.#sequence++ })
    })
  }

  /** How many sleepers are waiting. Useful for asserting a worker actually parked. */
  get pendingSleeps(): number {
    return this.#pending.length
  }

  /** The earliest deadline any sleeper is waiting on, or null if none are. */
  nextDeadline(): Millis | null {
    if (this.#pending.length === 0) return null
    return this.#pending.reduce((min, p) => (p.dueAt < min ? p.dueAt : min), Infinity)
  }

  /**
   * Move time forward by `ms`, waking sleepers as their deadlines pass.
   *
   * Awaiting the returned promise yields to the microtask queue after each
   * wake, so code that resumes and immediately sleeps again is scheduled
   * before the clock moves on.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      const due = this.#pending
        .filter((p) => p.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.sequence - b.sequence)
      const next = due[0]
      if (next === undefined) break

      this.#now = next.dueAt
      this.#pending = this.#pending.filter((p) => p !== next)
      next.resolve()
      // Let the woken task run before considering the next deadline.
      await Promise.resolve()
      await Promise.resolve()
    }
    this.#now = target
  }

  /** Jump straight to the next pending deadline. Returns false if nothing is waiting. */
  async advanceToNextDeadline(): Promise<boolean> {
    const next = this.nextDeadline()
    if (next === null) return false
    await this.advance(next - this.#now)
    return true
  }

  /** Move time without waking anyone — for simulating clock skew. */
  setNow(at: Millis): void {
    this.#now = at
  }
}
