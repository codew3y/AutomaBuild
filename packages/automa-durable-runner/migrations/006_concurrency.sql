-- Support for concurrency limits enforced at claim time.
--
-- Two things are needed: a cheap way to count what a tenant or a flow is
-- currently running, and the flow identity on the step row so that count does
-- not require joining back to `runs` across ninety partitions.
--
-- Limits are counted over steps holding a *live* lease. A step whose lease has
-- lapsed is not running — its worker is gone — and counting it would let one
-- crashed process permanently consume a slot.

ALTER TABLE step_executions ADD COLUMN flow_id uuid;

COMMENT ON COLUMN step_executions.flow_id IS
  'Denormalised from runs. Present so per-flow concurrency can be counted without joining a partitioned table.';

-- The counting index. Partial, because steps that are not running are the
-- overwhelming majority and are never counted.
CREATE INDEX step_exec_running_by_tenant
  ON step_executions (tenant_id, lease_expires_at)
  WHERE status = 'running';

CREATE INDEX step_exec_running_by_flow
  ON step_executions (flow_id, lease_expires_at)
  WHERE status = 'running';

-- Per-flow serialisation, for flows that must not interleave with themselves
-- (appending to a sheet, incrementing a counter). Stored on the run so the
-- limit travels with the work rather than living in a worker's configuration.
ALTER TABLE runs ADD COLUMN max_concurrent_steps integer;

COMMENT ON COLUMN runs.max_concurrent_steps IS
  'Per-flow concurrent step ceiling for this run. NULL means the engine default. 1 means strict serialisation.';
