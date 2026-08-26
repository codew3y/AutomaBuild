-- Trigger-level deduplication, done somewhere it can actually work.
--
-- The obvious approach — a partial unique index on runs — cannot work, and
-- fails in the worst way: silently, while appearing correct.
--
--   CREATE UNIQUE INDEX ON runs (started_at, tenant_id, flow_id, idempotency_key)
--
-- A unique index on a partitioned table must contain every partition key
-- column, so `started_at` has to be in there. But `started_at` defaults to
-- now(), so every insert produces a distinct key and the index rejects only
-- rows landing in the same microsecond. It looks like a uniqueness guarantee,
-- it passes casual review, and it prevents nothing.
--
-- The fix is to put the guarantee in a table that is not partitioned, where a
-- real primary key on (tenant_id, flow_id, idempotency_key) means what it
-- says. Starting a run inserts here first; a duplicate trigger delivery fails
-- on the primary key and the caller returns the original run instead of
-- creating a second one.
--
-- This table stays small because a janitor deletes rows older than the window
-- in which a duplicate delivery is plausible. It is not run history — runs is
-- run history.

DROP INDEX IF EXISTS runs_idempotency;

CREATE TABLE run_idempotency (
  tenant_id       uuid        NOT NULL,
  flow_id         uuid        NOT NULL,
  idempotency_key text        NOT NULL,

  -- Points back at the run this key created. Both columns, because reaching a
  -- partitioned table efficiently requires its partition key.
  run_id          uuid        NOT NULL,
  run_started_at  timestamptz NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, flow_id, idempotency_key)
);

COMMENT ON TABLE run_idempotency IS
  'Deduplicates trigger deliveries. Deliberately not partitioned: a unique key on a partitioned table must include the partition key, which would make the constraint vacuous.';

-- The janitor sweeps by age. Every provider that retries a webhook gives up
-- long before this.
CREATE INDEX run_idempotency_sweep ON run_idempotency (created_at);
