-- The outbox is what removes the dual write.
--
-- Without it, "advance the run" means two operations against two systems: a
-- state change in Postgres and an enqueue in Redis. There is no ordering of
-- those two that is safe. Write the database first and crash, and the work is
-- never scheduled. Enqueue first and crash, and a worker picks up a run whose
-- state says something else. Neither can be fixed with a retry, because the
-- crash is between them.
--
-- So the state change and the enqueue become one transaction: the row lands in
-- this table with the state it describes, and a relay moves it to the queue
-- afterwards. The relay may publish the same row more than once — that is
-- inherent, and the lease guard on step_executions is what makes a duplicate
-- delivery a no-op.
--
-- Deliberately not partitioned: it stays small because rows are deleted once
-- relayed, and it is claimed with FOR UPDATE SKIP LOCKED many times a second.

CREATE TABLE outbox (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic        text        NOT NULL CHECK (topic IN ('advance_run','run_step')),
  payload      jsonb       NOT NULL,
  tenant_id    uuid,

  -- The relay ignores rows until this instant, which is how a retry is
  -- scheduled without a separate timer: the executor computes the backoff and
  -- writes the row with a future availability.
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The relay's only query:
--   SELECT * FROM outbox WHERE available_at <= now()
--   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100
-- SKIP LOCKED is what lets several relay processes run without blocking each
-- other or handing the same row to two of them.
CREATE INDEX outbox_claim ON outbox (available_at, id);

-- Where work goes to be looked at by a human.
--
-- Never auto-drained. An entry here means either the attempts ran out, or the
-- payload is deterministically unprocessable, or the same node has failed
-- identically across enough runs that the flow itself is broken rather than
-- the data. Draining automatically would turn all three into an infinite loop.
CREATE TABLE dlq_entries (
  id                uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid        NOT NULL,

  run_id            uuid,
  run_started_at    timestamptz(3),
  step_execution_id uuid,
  flow_version_id   uuid,
  node_id           text,

  origin_topic      text        NOT NULL,
  reason            text        NOT NULL CHECK (reason IN (
                      'attempts_exhausted','deferrals_exhausted','poison',
                      'deserialize_failed','flow_poison')),
  error_class       text,
  error_chain       jsonb,

  -- Everything needed to run this again without reconstructing it by hand:
  -- resolved input, connector and flow version, the original idempotency key.
  -- A DLQ entry that cannot be replayed is a log line with extra steps.
  replay_payload    jsonb       NOT NULL,

  replayed_at       timestamptz,
  replayed_run_id   uuid,
  resolved_at       timestamptz,
  resolved_by       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dlq_open ON dlq_entries (tenant_id, created_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX dlq_by_run ON dlq_entries (run_id) WHERE run_id IS NOT NULL;

-- A flow-level poison signal: the same node failing identically across many
-- runs means the flow is broken, not the payload. Counted here so the fuse can
-- be evaluated without scanning step_executions.
CREATE INDEX dlq_flow_poison ON dlq_entries (flow_version_id, node_id, created_at DESC);
