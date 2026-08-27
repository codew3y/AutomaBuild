/**
 * Every read and write the engine makes.
 *
 * The important function in this file is `claimStep`. Everything else is
 * bookkeeping; that one is what makes at-least-once delivery survivable.
 */

import type { Executor } from '../db/client.ts'
import { stepIdempotencyKey } from '../idempotency.ts'
import type {
  FlowDefinition,
  OutboxMessage,
  OutboxTopic,
  RunRow,
  RunStatus,
  StepRow,
  StepStatus,
} from '../types.ts'

/* ------------------------------------------------------------------ runs */

export interface CreateRunInput {
  readonly tenantId: string
  readonly flow: FlowDefinition
  readonly input?: unknown
  /** Trigger-level dedup key. A repeat delivery returns the original run. */
  readonly idempotencyKey?: string
  readonly runTimeoutMs?: number
  readonly isTest?: boolean
}

export interface CreateRunResult {
  readonly run: RunRow
  /** True when an existing run was returned instead of a new one being made. */
  readonly deduplicated: boolean
}

/**
 * Column list, optionally qualified.
 *
 * The qualified form is not decoration: `runs` and `run_idempotency` share
 * tenant_id, flow_id and run-identifying columns, so an unqualified list makes
 * any join between them ambiguous and Postgres refuses the query.
 */
function runColumns(alias = ''): string {
  const prefix = alias === '' ? '' : `${alias}.`
  return [
    'id',
    'tenant_id',
    'flow_id',
    'flow_version_id',
    'status',
    'attempt_group',
    'started_at',
    'finished_at',
    'deadline_at',
    'cancel_requested_at',
    'cancelled_at_step_id',
    'step_count',
    'steps_succeeded',
    'steps_failed',
    'error_class',
    'error_code',
  ]
    .map((column) => `${prefix}${column}`)
    .join(', ')
}

const RUN_COLUMNS = runColumns()

function toRun(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    flowId: row.flow_id as string,
    flowVersionId: row.flow_version_id as string,
    status: row.status as RunStatus,
    attemptGroup: row.attempt_group as number,
    startedAt: row.started_at as Date,
    finishedAt: (row.finished_at as Date | null) ?? null,
    deadlineAt: (row.deadline_at as Date | null) ?? null,
    cancelRequestedAt: (row.cancel_requested_at as Date | null) ?? null,
    cancelledAtStepId: (row.cancelled_at_step_id as string | null) ?? null,
    stepCount: row.step_count as number,
    stepsSucceeded: row.steps_succeeded as number,
    stepsFailed: row.steps_failed as number,
    errorClass: (row.error_class as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
  }
}

/**
 * Create a run and every step row it will need, then schedule it.
 *
 * All of it in one transaction, including the outbox row. A run that exists
 * but was never scheduled is invisible work; a schedule with no run behind it
 * is a worker crash. Neither is possible if they commit together.
 *
 * Steps are materialised up front rather than as the run advances. That costs
 * a few rows nobody may execute, and buys the ability to answer "where did
 * this run get to" with a single query, plus a natural place to hang the
 * idempotency key before anything has run.
 */
export async function createRun(
  tx: Executor,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  if (input.idempotencyKey !== undefined) {
    const existing = await findRunByIdempotencyKey(
      tx,
      input.tenantId,
      input.flow.id,
      input.idempotencyKey,
    )
    if (existing !== null) return { run: existing, deduplicated: true }
  }

  const { rows } = await tx.query(
    `INSERT INTO runs (tenant_id, flow_id, flow_version_id, status, is_test, input_inline, deadline_at)
     VALUES ($1, $2, $3, 'queued', $4, $5,
             CASE WHEN $6::bigint IS NULL THEN NULL
                  ELSE now() + ($6::bigint * interval '1 millisecond') END)
     RETURNING ${RUN_COLUMNS}`,
    [
      input.tenantId,
      input.flow.id,
      input.flow.versionId,
      input.isTest ?? false,
      input.input === undefined ? null : JSON.stringify(input.input),
      input.runTimeoutMs ?? null,
    ],
  )
  const run = toRun(rows[0]!)

  if (input.idempotencyKey !== undefined) {
    // Claiming the key can lose a race with a concurrent duplicate delivery.
    // The loser returns the winner's run, so the caller sees one run either way.
    //
    // The SAVEPOINT is required, not defensive. In Postgres any statement error
    // aborts the entire transaction: without a savepoint to roll back to, the
    // recovery query below fails with "current transaction is aborted" and the
    // duplicate surfaces as an error instead of being handled.
    await tx.query('SAVEPOINT claim_idempotency_key')
    try {
      await tx.query(
        `INSERT INTO run_idempotency (tenant_id, flow_id, idempotency_key, run_id, run_started_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.tenantId, input.flow.id, input.idempotencyKey, run.id, run.startedAt],
      )
      await tx.query('RELEASE SAVEPOINT claim_idempotency_key')
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT claim_idempotency_key')
      if ((error as { code?: string }).code === '23505') {
        const winner = await findRunByIdempotencyKey(
          tx,
          input.tenantId,
          input.flow.id,
          input.idempotencyKey,
        )
        if (winner !== null) return { run: winner, deduplicated: true }
      }
      throw error
    }
  }

  await insertSteps(tx, run, input.flow)
  await enqueue(tx, {
    topic: 'advance_run',
    payload: { runId: run.id, runStartedAt: run.startedAt.toISOString() },
    tenantId: input.tenantId,
  })

  return { run, deduplicated: false }
}

async function findRunByIdempotencyKey(
  tx: Executor,
  tenantId: string,
  flowId: string,
  key: string,
): Promise<RunRow | null> {
  const { rows } = await tx.query(
    `SELECT ${runColumns('r')}
       FROM runs r
       JOIN run_idempotency k
         ON k.run_id = r.id AND k.run_started_at = r.started_at
      WHERE k.tenant_id = $1 AND k.flow_id = $2 AND k.idempotency_key = $3`,
    [tenantId, flowId, key],
  )
  return rows.length === 0 ? null : toRun(rows[0]!)
}

async function insertSteps(tx: Executor, run: RunRow, flow: FlowDefinition): Promise<void> {
  let order = 0
  for (const node of flow.nodes) {
    await tx.query(
      `INSERT INTO step_executions
         (tenant_id, run_id, run_started_at, node_id, iteration_index, topo_order,
          step_kind, status, idempotency_key, max_attempts, flow_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, 'pending', $7, $8, $9)`,
      [
        run.tenantId,
        run.id,
        run.startedAt,
        node.id,
        order,
        node.kind,
        stepIdempotencyKey({
          runId: run.id,
          nodeId: node.id,
          iterationIndex: 0,
          attemptGroup: run.attemptGroup,
        }),
        node.maxAttempts ?? 5,
        run.flowId,
      ],
    )
    order++
  }
  await tx.query(
    `UPDATE runs SET step_count = $3 WHERE started_at = $1 AND id = $2`,
    [run.startedAt, run.id, flow.nodes.length],
  )
}

export async function getRun(
  tx: Executor,
  runStartedAt: Date,
  runId: string,
): Promise<RunRow | null> {
  const { rows } = await tx.query(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE started_at = $1 AND id = $2`,
    [runStartedAt, runId],
  )
  return rows.length === 0 ? null : toRun(rows[0]!)
}

export async function setRunStatus(
  tx: Executor,
  run: { id: string; startedAt: Date },
  status: RunStatus,
  detail?: {
    errorClass?: string
    errorCode?: string
    errorStepId?: string
    /**
     * Where a cancelled run actually stopped.
     *
     * "Cancelled" on its own is not much use to whoever asks what happened:
     * they need to know which steps ran and which never will.
     */
    cancelledAtStepId?: string
  },
): Promise<void> {
  await tx.query(
    `UPDATE runs
        SET status = $3,
            finished_at = CASE WHEN $3 IN ('succeeded','failed','cancelled','timed_out')
                               THEN now() ELSE finished_at END,
            error_class = COALESCE($4, error_class),
            error_code = COALESCE($5, error_code),
            error_step_id = COALESCE($6, error_step_id),
            cancelled_at_step_id = COALESCE($7, cancelled_at_step_id)
      WHERE started_at = $1 AND id = $2`,
    [
      run.startedAt,
      run.id,
      status,
      detail?.errorClass ?? null,
      detail?.errorCode ?? null,
      detail?.errorStepId ?? null,
      detail?.cancelledAtStepId ?? null,
    ],
  )
}

/** Cooperative cancellation: set the flag; the orchestrator checks it at every transition. */
export async function requestCancel(
  tx: Executor,
  run: { id: string; startedAt: Date },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE runs SET cancel_requested_at = COALESCE(cancel_requested_at, now())
      WHERE started_at = $1 AND id = $2
        AND status NOT IN ('succeeded','failed','cancelled','timed_out')`,
    [run.startedAt, run.id],
  )
  return (rowCount ?? 0) > 0
}

/* ------------------------------------------------------------------ steps */

const STEP_COLUMNS = `
  id, tenant_id, run_id, run_started_at, node_id, iteration_index, topo_order,
  step_kind, status, attempts_started, attempts_consumed, deferrals,
  max_attempts, max_deferrals, next_attempt_at, idempotency_key,
  lease_expires_at, worker_id, input_inline, output_inline,
  error_class, error_code, error_message
`

function toStep(row: Record<string, unknown>): StepRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    runId: row.run_id as string,
    runStartedAt: row.run_started_at as Date,
    nodeId: row.node_id as string,
    iterationIndex: row.iteration_index as number,
    topoOrder: row.topo_order as number,
    stepKind: row.step_kind as string,
    status: row.status as StepStatus,
    attemptsStarted: row.attempts_started as number,
    attemptsConsumed: row.attempts_consumed as number,
    deferrals: row.deferrals as number,
    maxAttempts: row.max_attempts as number,
    maxDeferrals: row.max_deferrals as number,
    nextAttemptAt: (row.next_attempt_at as Date | null) ?? null,
    idempotencyKey: row.idempotency_key as string,
    leaseExpiresAt: (row.lease_expires_at as Date | null) ?? null,
    workerId: (row.worker_id as string | null) ?? null,
    inputInline: row.input_inline ?? null,
    outputInline: row.output_inline ?? null,
    errorClass: (row.error_class as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  }
}

/**
 * The next step this run should execute, or null if there is none.
 *
 * Linear chains, so "next" is the lowest topo_order that is not finished. A
 * step waiting on a retry that is not yet due counts as unfinished but is not
 * returned — the run is not advanced, it is waiting.
 */
export async function nextRunnableStep(
  tx: Executor,
  run: { id: string; startedAt: Date },
): Promise<StepRow | null> {
  const { rows } = await tx.query(
    `SELECT ${STEP_COLUMNS}
       FROM step_executions
      WHERE run_started_at = $1 AND run_id = $2
        AND (status = 'pending'
             OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
             OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()))
      ORDER BY topo_order
      LIMIT 1`,
    [run.startedAt, run.id],
  )
  return rows.length === 0 ? null : toStep(rows[0]!)
}

export interface ConcurrencyLimits {
  /** Concurrent steps this tenant may have in flight. */
  readonly perTenant?: number
  /** Concurrent steps one flow may have in flight. 1 serialises the flow. */
  readonly perFlow?: number
}

export interface ClaimInput {
  readonly runStartedAt: Date
  readonly stepId: string
  readonly workerId: string
  readonly leaseMs: number
  /** Required when limits are supplied — the counters are keyed on it. */
  readonly tenantId?: string
  readonly flowId?: string
  readonly limits?: ConcurrencyLimits
}

/**
 * Why a claim did not succeed, which the caller must tell apart.
 *
 * `taken` means someone else owns the step: stop, do nothing, this delivery
 * was a duplicate. `blocked` means the step is still ours to run and the
 * system is merely busy — it must be retried later without counting as a
 * failure, or a burst of traffic would burn every step's attempt budget.
 */
export type ClaimResult =
  | { readonly kind: 'claimed'; readonly step: StepRow }
  | { readonly kind: 'taken' }
  | {
      readonly kind: 'blocked'
      readonly scope: 'tenant' | 'flow'
      readonly running: number
      readonly limit: number
    }

/**
 * Claim a step for execution. Returns the claimed row, or null if someone else
 * has it.
 *
 * This is the guard that makes at-least-once delivery safe. The queue may hand
 * the same message to two workers; it may hand a message to a worker while the
 * original is still running; a crashed worker leaves a row that looks claimed
 * forever. All three are the same problem, and one conditional UPDATE answers
 * all of them:
 *
 *   - `pending`  — nobody has started it
 *   - `failed` with a due `next_attempt_at` — a retry is owed
 *   - `running` with an expired lease — the previous owner died
 *
 * Anything else, and the UPDATE matches zero rows: the second worker learns it
 * lost and exits without touching anything. There is no read-then-write here,
 * so there is no window between checking and claiming.
 *
 * `attempts_started` increments; `attempts_consumed` does not. Whether an
 * attempt was spent is decided by how it *ends*, not by it beginning.
 */
export async function claimStep(tx: Executor, input: ClaimInput): Promise<ClaimResult> {
  // Concurrency is checked here, at claim time, never at enqueue time. A step
  // waiting in the queue consumes nothing; only one actually executing does.
  // Enforcing at enqueue would mean refusing to schedule work that will be
  // perfectly fine to run in a second's time.
  if (input.limits !== undefined) {
    const blocked = await checkLimits(tx, input)
    if (blocked !== null) return { kind: 'blocked', scope: blocked.scope, running: blocked.running, limit: blocked.limit }
  }

  const { rows } = await tx.query(
    `UPDATE step_executions
        SET status = 'running',
            worker_id = $3,
            lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
            attempts_started = attempts_started + 1,
            started_at = COALESCE(started_at, now())
      WHERE run_started_at = $1
        AND id = $2
        AND (
              status = 'pending'
              OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now())
              OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
            )
      RETURNING ${STEP_COLUMNS}`,
    [input.runStartedAt, input.stepId, input.workerId, input.leaseMs],
  )
  return rows.length === 0 ? { kind: 'taken' } : { kind: 'claimed', step: toStep(rows[0]!) }
}

/**
 * Is this claim over a concurrency ceiling?
 *
 * Takes a transaction-scoped advisory lock on the tenant first. Without it,
 * two workers can both count nine running steps against a limit of ten and
 * both proceed, because under READ COMMITTED neither sees the other's
 * uncommitted claim. Serialising the count is cheap — a claim is a
 * sub-millisecond statement — and the alternative is a limit that is only
 * approximately a limit, which is the same as not having one.
 *
 * Only steps holding a *live* lease count. A lapsed lease means its worker is
 * gone, and counting it would let one crashed process permanently occupy a
 * slot no one can use.
 */
async function checkLimits(
  tx: Executor,
  input: ClaimInput,
): Promise<{ scope: 'tenant' | 'flow'; running: number; limit: number } | null> {
  const limits = input.limits!
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`claim:${input.tenantId}`])

  if (limits.perTenant !== undefined) {
    const { rows } = await tx.query<{ running: string }>(
      `SELECT count(*)::text AS running
         FROM step_executions
        WHERE tenant_id = $1
          AND status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > now()`,
      [input.tenantId],
    )
    const running = Number(rows[0]!.running)
    if (running >= limits.perTenant) {
      return { scope: 'tenant', running, limit: limits.perTenant }
    }
  }

  if (limits.perFlow !== undefined && input.flowId !== undefined) {
    const { rows } = await tx.query<{ running: string }>(
      `SELECT count(*)::text AS running
         FROM step_executions
        WHERE flow_id = $1
          AND status = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > now()`,
      [input.flowId],
    )
    const running = Number(rows[0]!.running)
    if (running >= limits.perFlow) {
      return { scope: 'flow', running, limit: limits.perFlow }
    }
  }

  return null
}

/**
 * Extend a lease held by this worker.
 *
 * Scoped to `worker_id` deliberately: if the lease already expired and another
 * worker took over, this must fail rather than yank the step back and give two
 * workers a claim on it.
 */
export async function renewLease(
  tx: Executor,
  input: { runStartedAt: Date; stepId: string; workerId: string; leaseMs: number },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE step_executions
        SET lease_expires_at = now() + ($4::bigint * interval '1 millisecond')
      WHERE run_started_at = $1 AND id = $2 AND worker_id = $3 AND status = 'running'`,
    [input.runStartedAt, input.stepId, input.workerId, input.leaseMs],
  )
  return (rowCount ?? 0) > 0
}

export async function recordSuccess(
  tx: Executor,
  input: {
    runStartedAt: Date
    stepId: string
    workerId: string
    output?: unknown
  },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE step_executions
        SET status = 'succeeded',
            output_inline = $4,
            finished_at = now(),
            duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
            lease_expires_at = NULL,
            next_attempt_at = NULL
      WHERE run_started_at = $1 AND id = $2 AND worker_id = $3 AND status = 'running'`,
    [
      input.runStartedAt,
      input.stepId,
      input.workerId,
      input.output === undefined ? null : JSON.stringify(input.output),
    ],
  )
  return (rowCount ?? 0) > 0
}

export interface RecordFailureInput {
  readonly runStartedAt: Date
  readonly stepId: string
  readonly workerId: string
  readonly status: Extract<StepStatus, 'failed' | 'timed_out' | 'waiting_confirmation'>
  readonly attemptsConsumed: number
  readonly deferrals: number
  /**
   * Delay until the next attempt, or null when there will not be one.
   *
   * A duration rather than an instant, deliberately. The instant is computed
   * by Postgres as `now() + delay`, so every wake time in the system comes
   * from one clock. Sending an absolute timestamp from Node would introduce a
   * second clock, and delayed work is scored against absolute timestamps —
   * two nodes disagreeing by a few seconds means steps firing early or late
   * with nothing in any log to explain it.
   */
  readonly retryDelayMs: number | null
  readonly errorClass: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly httpStatus?: number
}

/**
 * Write the outcome of a failed attempt.
 *
 * Counters are written as absolute values from the pure state machine rather
 * than incremented in SQL. The decision about whether this failure cost an
 * attempt lives in one place — `src/retry.ts` — and duplicating it as
 * `attempts_consumed + 1` here would mean two implementations that can drift.
 */
export async function recordFailure(
  tx: Executor,
  input: RecordFailureInput,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE step_executions
        SET status = $4,
            attempts_consumed = $5,
            deferrals = $6,
            next_attempt_at = CASE WHEN $7::bigint IS NULL THEN NULL
                                   ELSE now() + ($7::bigint * interval '1 millisecond') END,
            error_class = $8,
            error_code = $9,
            error_message = $10,
            http_status = $11,
            finished_at = now(),
            duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
            lease_expires_at = NULL
      WHERE run_started_at = $1 AND id = $2 AND worker_id = $3 AND status = 'running'`,
    [
      input.runStartedAt,
      input.stepId,
      input.workerId,
      input.status,
      input.attemptsConsumed,
      input.deferrals,
      input.retryDelayMs,
      input.errorClass,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.httpStatus ?? null,
    ],
  )
  return (rowCount ?? 0) > 0
}

export async function listSteps(
  tx: Executor,
  run: { id: string; startedAt: Date },
): Promise<StepRow[]> {
  const { rows } = await tx.query(
    `SELECT ${STEP_COLUMNS} FROM step_executions
      WHERE run_started_at = $1 AND run_id = $2 ORDER BY topo_order`,
    [run.startedAt, run.id],
  )
  return rows.map(toStep)
}

/* -------------------------------------------------------------------- dlq */

export interface DlqInput {
  readonly tenantId: string
  readonly runId?: string
  readonly runStartedAt?: Date
  readonly stepExecutionId?: string
  readonly flowVersionId?: string
  readonly nodeId?: string
  readonly originTopic: string
  readonly reason:
    | 'attempts_exhausted'
    | 'deferrals_exhausted'
    | 'poison'
    | 'deserialize_failed'
    | 'flow_poison'
  readonly errorClass?: string
  readonly errorChain?: unknown
  /**
   * Everything needed to run this again without reconstructing it by hand.
   * A DLQ entry that cannot be replayed is a log line with extra steps.
   */
  readonly replayPayload: Record<string, unknown>
}

export async function writeDlqEntry(tx: Executor, input: DlqInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO dlq_entries
       (tenant_id, run_id, run_started_at, step_execution_id, flow_version_id,
        node_id, origin_topic, reason, error_class, error_chain, replay_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      input.tenantId,
      input.runId ?? null,
      input.runStartedAt ?? null,
      input.stepExecutionId ?? null,
      input.flowVersionId ?? null,
      input.nodeId ?? null,
      input.originTopic,
      input.reason,
      input.errorClass ?? null,
      input.errorChain === undefined ? null : JSON.stringify(input.errorChain),
      JSON.stringify(input.replayPayload),
    ],
  )
  return rows[0]!.id
}

export async function listDlqEntries(
  tx: Executor,
  filter: { runId?: string; tenantId?: string } = {},
): Promise<
  Array<{ id: string; reason: string; errorClass: string | null; replayPayload: unknown; nodeId: string | null }>
> {
  const { rows } = await tx.query(
    `SELECT id, reason, error_class, replay_payload, node_id
       FROM dlq_entries
      WHERE ($1::uuid IS NULL OR run_id = $1)
        AND ($2::uuid IS NULL OR tenant_id = $2)
      ORDER BY created_at DESC`,
    [filter.runId ?? null, filter.tenantId ?? null],
  )
  return rows.map((row) => ({
    id: row.id as string,
    reason: row.reason as string,
    errorClass: (row.error_class as string | null) ?? null,
    replayPayload: row.replay_payload,
    nodeId: (row.node_id as string | null) ?? null,
  }))
}

/* ----------------------------------------------------------------- outbox */

export interface EnqueueInput {
  readonly topic: OutboxTopic
  readonly payload: Record<string, unknown>
  readonly tenantId?: string | null
  /**
   * Milliseconds to hold the row back, computed into an instant by Postgres.
   * This is how a retry is scheduled without a separate timer.
   */
  readonly delayMs?: number
}

export async function enqueue(tx: Executor, input: EnqueueInput): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbox (topic, payload, tenant_id, available_at)
     VALUES ($1, $2, $3,
             CASE WHEN $4::bigint IS NULL THEN now()
                  ELSE now() + ($4::bigint * interval '1 millisecond') END)
     RETURNING id::text`,
    [input.topic, JSON.stringify(input.payload), input.tenantId ?? null, input.delayMs ?? null],
  )
  return rows[0]!.id
}

/**
 * Claim a batch of due outbox rows.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several relays run at once: each takes
 * rows the others have not locked, rather than queueing behind them. Rows stay
 * locked until the caller's transaction ends, so the relay must dispatch and
 * delete inside that same transaction.
 */
export async function claimOutboxBatch(
  tx: Executor,
  limit: number,
  tenantId?: string,
): Promise<OutboxMessage[]> {
  const { rows } = await tx.query(
    `SELECT id::text AS id, topic, payload, tenant_id, attempts
       FROM outbox
      WHERE available_at <= now()
        AND ($2::uuid IS NULL OR tenant_id = $2)
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT $1`,
    [limit, tenantId ?? null],
  )
  return rows.map((row) => ({
    id: row.id as string,
    topic: row.topic as OutboxTopic,
    payload: row.payload as Record<string, unknown>,
    tenantId: (row.tenant_id as string | null) ?? null,
    attempts: row.attempts as number,
  }))
}

export async function deleteOutbox(tx: Executor, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0
  const { rowCount } = await tx.query(`DELETE FROM outbox WHERE id = ANY($1::bigint[])`, [ids])
  return rowCount ?? 0
}

/** Defer a row that could not be dispatched, so the relay does not spin on it. */
export async function deferOutbox(
  tx: Executor,
  id: string,
  delayMs: number,
): Promise<void> {
  await tx.query(
    `UPDATE outbox
        SET attempts = attempts + 1,
            available_at = now() + ($2::bigint * interval '1 millisecond')
      WHERE id = $1::bigint`,
    [id, delayMs],
  )
}
