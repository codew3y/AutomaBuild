/**
 * Replay protection.
 *
 * A valid signature proves a request came from the sender. It does not prove
 * the sender sent it *now*, or that this is the first time you have seen it.
 * Capture a signed request off the wire and you can send it again; every
 * signature check will pass, because the request genuinely is authentic.
 *
 * Two mechanisms guard against that, and both are needed:
 *
 * **The timestamp window** bounds how long a captured request stays useful.
 * It is worth little on its own — five minutes is plenty of time to replay
 * something — and GitHub's scheme has no timestamp at all, so the window does
 * not exist there.
 *
 * **This store** remembers what has already been seen. It is what turns
 * "authentic" into "authentic and new".
 *
 * The interface is deliberately narrow: one call that is both the check and
 * the record. Splitting it into `has()` then `remember()` would put a gap
 * between them, and two copies of a replayed request arriving simultaneously
 * would both find nothing and both be accepted.
 */

export type DeliveryOutcome =
  | 'accepted'
  | 'duplicate'
  | 'rejected_signature'
  | 'rejected_size'
  | 'rejected_timestamp'

export interface DeliveryRecord {
  readonly endpointId: string
  readonly dedupKey: string
  readonly outcome: DeliveryOutcome
  readonly receivedAt: Date
}

export interface RecordResult {
  /**
   * True when this store had not seen the key before.
   *
   * False means a duplicate, and the caller should return 200 without doing
   * any work — a webhook sender retrying is not an error, and a 4xx would make
   * it retry harder.
   */
  readonly first: boolean
  /** When the original was seen, for a duplicate. */
  readonly originallyAt?: Date
}

export interface ReplayStore {
  /**
   * Atomically record a delivery and report whether it is new.
   *
   * Must be a single operation. A read followed by a write leaves a window in
   * which two simultaneous copies of the same replayed request both see
   * nothing and are both accepted — which is precisely the attack.
   */
  record(record: DeliveryRecord): Promise<RecordResult>

  /**
   * Forget a record, so the next copy of that delivery is treated as new.
   *
   * This exists for one situation, and it is not a hypothetical: `record` is
   * called before the delivery is handed off, because the record is what stops
   * two simultaneous copies both being accepted. If the handoff then fails —
   * the database is down, the queue is unreachable — the record stands, the
   * caller returns 500, and the sender's retry is answered "duplicate". The
   * delivery is lost, silently and permanently.
   *
   * Releasing the record on a failed handoff turns that into a retry that
   * works. It reopens a narrow window: a concurrent replay arriving between the
   * failure and the release is treated as new. That is a far better trade than
   * guaranteed loss, and a consumer whose handoff is itself idempotent — one
   * keyed on the same dedup key — closes it completely.
   *
   * Releasing a key that is not there is not an error.
   */
  release(endpointId: string, dedupKey: string): Promise<void>

  /** Drop records older than the retention window. */
  prune(olderThan: Date): Promise<number>

  close?(): Promise<void>
}

/**
 * How long records must be kept.
 *
 * At minimum the timestamp tolerance, because anything older than that is
 * already rejected by the window and remembering it adds nothing. In practice
 * longer, because schemes with no timestamp — GitHub — have no window to fall
 * back on, and their only protection is that this store still remembers the
 * delivery id.
 *
 * The default is 24 hours: comfortably beyond every sender's retry schedule,
 * and short enough that the table stays small.
 */
export const DEFAULT_RETENTION_SECONDS = 86_400

export function assertRetentionCoversTolerance(
  retentionSeconds: number,
  toleranceSeconds: number,
): void {
  if (retentionSeconds < toleranceSeconds) {
    throw new RangeError(
      `Retention (${retentionSeconds}s) is shorter than the timestamp tolerance ` +
        `(${toleranceSeconds}s). A request could be forgotten while still inside its ` +
        `validity window, and replayed successfully.`,
    )
  }
}
