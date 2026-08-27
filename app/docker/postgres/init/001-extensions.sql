-- Copy of automa-durable-runner/docker/postgres/init/001-extensions.sql.
-- See the note at the top of the Dockerfile beside it for why this is a copy
-- and not a shared context. It creates extensions and grants; it does not
-- create application tables, which come from the engine's migrations.
--
-- Runs once, on first initialisation of an empty data directory.
--
-- Only extensions and the schema pg_partman lives in. The application tables
-- come from migrations, not from here — an init script that silently diverges
-- from the migration history is a trap, because it only ever runs on a fresh
-- volume and nobody notices the drift until production.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- pg_partman keeps its own configuration and maintenance functions in a
-- dedicated schema, out of the way of application tables.
CREATE SCHEMA IF NOT EXISTS partman;
CREATE EXTENSION IF NOT EXISTS pg_partman WITH SCHEMA partman;

GRANT USAGE ON SCHEMA partman TO automa;
GRANT ALL ON ALL TABLES IN SCHEMA partman TO automa;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA partman TO automa;

-- Sanity: uuidv7() is a core function in Postgres 18. If this database were
-- ever started on an older major version the failure should be loud and
-- immediate, not a confusing error the first time a run is inserted.
DO $$
BEGIN
  PERFORM uuidv7();
EXCEPTION WHEN undefined_function THEN
  RAISE EXCEPTION 'uuidv7() is missing — this schema requires PostgreSQL 18 or newer (found %)', version();
END
$$;
