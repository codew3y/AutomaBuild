# Postgres 18 with the two extensions the partitioning strategy depends on.
#
# pg_partman creates and drops the daily partitions; pg_cron runs its
# maintenance on a schedule. Neither ships with the official image, and neither
# runs on Windows at all — which is why this project develops against Linux
# containers rather than a native install.
#
# Postgres 18 also gives us uuidv7() in core. That matters more than it looks:
# v7 UUIDs are time-ordered, so inserts into runs and step_executions land at
# the right-hand edge of the index instead of scattering random pages across a
# table that takes the heaviest write load in the system.
FROM postgres:18-trixie

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        postgresql-18-partman \
        postgresql-18-cron; \
    rm -rf /var/lib/apt/lists/*

# pg_cron must be loaded at server start — it runs a background worker, so it
# cannot be created on demand inside a session like an ordinary extension.
# cron.database_name pins its job tables to our database rather than postgres.
RUN set -eux; \
    echo "shared_preload_libraries = 'pg_cron,pg_partman_bgw'" >> /usr/share/postgresql/postgresql.conf.sample; \
    echo "cron.database_name = 'automa'" >> /usr/share/postgresql/postgresql.conf.sample; \
    echo "pg_partman_bgw.dbname = 'automa'" >> /usr/share/postgresql/postgresql.conf.sample; \
    echo "pg_partman_bgw.interval = 3600" >> /usr/share/postgresql/postgresql.conf.sample
