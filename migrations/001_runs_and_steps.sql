-- The two tables that carry the state machine, and the two that will take the
-- heaviest write load in the system.
--
-- Four constraints shape everything here, all of them documented behaviour
-- rather than preference:
--
-- 1. A unique or primary key on a partitioned table must include every
--    partition key column. So `PRIMARY KEY (id)` is not available; it is
--    `(started_at, id)`. Every foreign-key-ish lookup has to carry the
--    timestamp, which is why step_executions denormalises `run_started_at`.
--
-- 2. Partition by time only, never tenant x time. Postgres handles a few
--    thousand partitions; daily x 90 days is 90. Daily x 90 x 500 tenants is
--    45,000, and each partition's metadata loads into the local memory of
--    every session that touches the table.
--
-- 3. No default partition, so partitions can be detached concurrently. That
--    is set at create_parent time in 003.
--
-- 4. There is deliberately no run_logs table. A per-step structured log table
--    is the highest-cardinality, lowest-value, highest-write-amplification
--    table available, and nobody queries it relationally. Logs go to stdout
--    with a run_id; what a user sees as "logs" is step_executions plus a
--    capped messages array on the step row.

CREATE TABLE runs (
  id                    uuid        NOT NULL DEFAULT uuidv7(),
  tenant_id             uuid        NOT NULL,
  flow_id               uuid        NOT NULL,
  flow_version_id       uuid        NOT NULL,

  status                text        NOT NULL CHECK (status IN (
                          'queued','running','waiting_confirmation',
                          'succeeded','failed','cancelled','timed_out')),
  is_test               boolean     NOT NULL DEFAULT false,

  -- Dedupes duplicate starts of the same logical work. Unique per tenant and
  -- flow, and only where supplied.
  idempotency_key       text,
  -- Incremented only by an operator replay. Threaded into every step's
  -- idempotency key so a replay is new intent while a retry is not.
  attempt_group         integer     NOT NULL DEFAULT 0,

  input_inline          jsonb,
  input_ref             text,
  input_bytes           integer,

  -- Classified, never a raw provider body: those leak credentials and change
  -- without warning.
  error_class           text,
  error_code            text,
  error_step_id         text,

  cancel_requested_at   timestamptz,
  cancelled_at_step_id  text,

  step_count            integer     NOT NULL DEFAULT 0,
  steps_succeeded       integer     NOT NULL DEFAULT 0,
  steps_failed          integer     NOT NULL DEFAULT 0,

  -- timestamptz(3), not timestamptz. This is the partition key, and it is
  -- round-tripped through JavaScript Dates, which hold milliseconds and not
  -- microseconds. At full precision now() stores .319437, a Date carries back
  -- .319, and every lookup by (started_at, id) silently misses. Worse, the
  -- value denormalised into step_executions.run_started_at would disagree
  -- with this column in its sub-millisecond digits, breaking the very
  -- partition-local join the denormalisation exists to enable.
  started_at            timestamptz(3) NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  -- Wall-clock deadline for the whole run, computed from the database clock so
  -- there is exactly one clock in the system.
  deadline_at           timestamptz,

  PRIMARY KEY (started_at, id)
) PARTITION BY RANGE (started_at);

COMMENT ON COLUMN runs.attempt_group IS
  'Bumped only by a user-initiated replay, never by an automatic retry. Feeds every step idempotency key.';

CREATE INDEX runs_tenant_recent      ON runs (tenant_id, started_at DESC);
CREATE INDEX runs_tenant_flow_recent ON runs (tenant_id, flow_id, started_at DESC);
CREATE INDEX runs_active             ON runs (tenant_id, status, started_at DESC)
  WHERE status IN ('queued','running','waiting_confirmation');
-- The janitor's sweep for runs that have outlived their deadline.
CREATE INDEX runs_overdue            ON runs (deadline_at)
  WHERE status IN ('queued','running');
CREATE UNIQUE INDEX runs_idempotency ON runs (started_at, tenant_id, flow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE step_executions (
  id                uuid        NOT NULL DEFAULT uuidv7(),
  tenant_id         uuid        NOT NULL,
  run_id            uuid        NOT NULL,
  -- Denormalised from runs.started_at. Required, not merely convenient: it is
  -- this table's partition key, and it is what makes a join to runs land in a
  -- single partition on each side instead of scanning ninety.
  run_started_at    timestamptz(3) NOT NULL,

  node_id           text        NOT NULL,
  -- Loop fan-out position. Always 0 in v1, which is linear chains only, but
  -- present because retrofitting it into the unique key later would mean
  -- rewriting every partition.
  iteration_index   integer     NOT NULL DEFAULT 0,
  topo_order        integer     NOT NULL,
  step_kind         text        NOT NULL,

  status            text        NOT NULL CHECK (status IN (
                      'pending','dispatched','running','succeeded','failed',
                      'skipped','skipped_resumed','cancelled','timed_out',
                      'waiting_confirmation')),

  -- Mirrors StepRetryState in src/retry.ts. attempts_started and
  -- attempts_consumed diverge whenever a failure was the provider's
  -- availability rather than our request; deferrals counts those separately so
  -- they can have their own ceiling and their own backoff ladder.
  attempts_started  integer     NOT NULL DEFAULT 0,
  attempts_consumed integer     NOT NULL DEFAULT 0,
  deferrals         integer     NOT NULL DEFAULT 0,
  max_attempts      integer     NOT NULL DEFAULT 5,
  max_deferrals     integer     NOT NULL DEFAULT 20,
  next_attempt_at   timestamptz,

  -- sha256(run_id || node_id || iteration_index || attempt_group). Constant
  -- across automatic retries so the provider can deduplicate; changes only on
  -- an operator replay.
  idempotency_key   text        NOT NULL,

  -- The concurrency guard. A worker claims a step with a conditional update on
  -- this column; if two workers receive the same message exactly one wins.
  lease_expires_at  timestamptz,
  worker_id         text,

  input_inline      jsonb,
  input_ref         text,
  output_inline     jsonb,
  output_ref        text,
  output_preview    jsonb,
  payload_bytes     integer,

  error_class       text,
  error_code        text,
  -- Sanitised at write time. Secrets must never reach this column.
  error_message     text,
  http_status       integer,
  -- Host only, for per-destination metrics. No path, no query string.
  destination_host  text,

  -- Capped at 50 entries and 8 KB by the application; what the UI calls logs.
  messages          jsonb       NOT NULL DEFAULT '[]'::jsonb,

  started_at        timestamptz,
  finished_at       timestamptz,
  duration_ms       integer,
  created_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (run_started_at, id)
) PARTITION BY RANGE (run_started_at);

-- One row per (run, node, iteration). This is what makes a duplicate queue
-- delivery a no-op rather than a second execution.
CREATE UNIQUE INDEX step_exec_identity ON step_executions
  (run_started_at, run_id, node_id, iteration_index);

CREATE INDEX step_exec_by_run ON step_executions (tenant_id, run_id);

-- The janitor's two sweeps. Both are partial indexes because the interesting
-- rows are a vanishing fraction of the table.
CREATE INDEX step_exec_expired_lease ON step_executions (lease_expires_at)
  WHERE status = 'running';
CREATE INDEX step_exec_due_retry ON step_executions (next_attempt_at)
  WHERE status = 'failed' AND next_attempt_at IS NOT NULL;
