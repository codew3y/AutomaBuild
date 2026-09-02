-- Hand the two partitioned tables to pg_partman.
--
-- Daily RANGE partitions. The granularity is chosen to match the shortest
-- retention tier, because an entire partition can be detached quickly whereas
-- a DELETE of the same rows rewrites the table and leaves the space behind.
-- Aligning the two means dropping old data is a metadata operation.
--
-- p_default_table => false is the load-bearing argument. pg_partman defaults
-- it to true, and a default partition makes DETACH CONCURRENTLY illegal — so
-- the whole reason for partitioning daily quietly stops working, and only
-- under load, months later, when there is enough data for it to matter.
--
-- The cost of no default partition is that a row outside every existing range
-- is rejected rather than silently filed away. That is the correct trade: a
-- run with a nonsensical timestamp should fail loudly at insert.

SELECT partman.create_parent(
  p_parent_table      => 'public.runs',
  p_control           => 'started_at',
  p_interval          => '1 day',
  p_type              => 'range',
  p_premake           => 7,           -- a week of partitions ahead of now
  p_start_partition   => (now() - interval '1 day')::text,
  p_default_table     => false
);

SELECT partman.create_parent(
  p_parent_table      => 'public.step_executions',
  p_control           => 'run_started_at',
  p_interval          => '1 day',
  p_type              => 'range',
  p_premake           => 7,
  p_start_partition   => (now() - interval '1 day')::text,
  p_default_table     => false
);

-- Retention. Detach rather than drop, so a mistake is recoverable: the old
-- partition becomes an ordinary table that can be inspected, exported, or
-- reattached. Dropping it outright makes a wrong retention setting permanent.
UPDATE partman.part_config
   SET retention                  = '90 days',
       retention_keep_table       = true,
       retention_keep_index       = false,
       infinite_time_partitions   = true
 WHERE parent_table IN ('public.runs', 'public.step_executions');

-- Maintenance, hourly. pg_partman's background worker is configured in the
-- image, but an explicit cron entry means partition creation is visible in
-- cron.job_run_details and can be alerted on.
--
-- Partition maintenance failing silently is the specific risk worth guarding:
-- nothing breaks until the day the premake window runs out, and then every
-- insert fails at once because there is no default partition to catch them.
SELECT cron.schedule(
  'partman-maintenance',
  '7 * * * *',
  $$CALL partman.run_maintenance_proc()$$
);
