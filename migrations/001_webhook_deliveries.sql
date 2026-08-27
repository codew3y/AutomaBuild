-- Replay protection.
--
-- **This table is deliberately not partitioned**, and that is the whole point
-- of its design rather than an oversight.
--
-- The engineering plan originally specified it partitioned by `received_at`
-- with `PRIMARY KEY (received_at, endpoint_id, dedup_key)`. That provides no
-- replay protection whatsoever, and fails silently. A unique or primary key on
-- a partitioned table must contain every partition key column, so `received_at`
-- has to be in it — and `received_at` defaults to now(), so every insert
-- produces a distinct key. A request replayed five minutes later, or five
-- milliseconds later, gets a different `received_at` and inserts happily. The
-- constraint rejects only two deliveries landing in the same microsecond,
-- which is not a thing that happens and is not what replay protection is for.
--
-- The rule: a uniqueness guarantee cannot live on a partitioned table unless
-- the partition key is genuinely part of what makes the row unique. For a
-- dedup key it never is — the entire purpose is to reject the same key
-- arriving at a *different* time.
--
-- The cost of not partitioning is that retention is a DELETE by age rather
-- than a partition detach. That is fine here: rows only need to outlive the
-- replay window, which is hours rather than the months of history a run table
-- accumulates, so the table stays small and the cheaper bulk deletion that
-- partitioning would have bought is not needed.

CREATE TABLE webhook_deliveries (
  endpoint_id  uuid        NOT NULL,
  dedup_key    text        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN (
                 'accepted','duplicate','rejected_signature',
                 'rejected_size','rejected_timestamp')),
  received_at  timestamptz(3) NOT NULL DEFAULT now(),

  -- The guarantee. Nothing else in this schema matters as much.
  PRIMARY KEY (endpoint_id, dedup_key)
);

COMMENT ON TABLE webhook_deliveries IS
  'Replay protection. Not partitioned on purpose: a unique key on a partitioned table must include the partition key, which would make this constraint vacuous.';

-- Retention sweep. The only other access pattern.
CREATE INDEX webhook_deliveries_sweep ON webhook_deliveries (received_at);
