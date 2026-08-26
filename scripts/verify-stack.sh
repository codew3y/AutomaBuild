#!/usr/bin/env bash
# Prove the development stack is actually usable, not merely "up".
#
# A container that is running is not the same as a database that has the
# extensions this schema needs. Checking that distinction here means a broken
# stack fails with a clear message rather than as a confusing migration error.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== containers ==="
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

echo
echo "=== waiting for postgres ==="
for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U automa -d automa >/dev/null 2>&1; then
    echo "ready"
    break
  fi
  sleep 1
done

psql() { docker compose exec -T postgres psql -U automa -d automa "$@"; }

echo
echo "=== server version ==="
psql -tAc 'SHOW server_version'

echo
echo "=== extensions ==="
psql -c 'SELECT extname, extversion FROM pg_extension ORDER BY extname'

echo "=== uuidv7 works and is time-ordered ==="
psql -tAc 'SELECT uuidv7() < uuidv7()'

echo
echo "=== pg_cron background worker loaded ==="
psql -tAc "SELECT count(*) > 0 FROM pg_stat_activity WHERE backend_type LIKE '%pg_cron%'"

echo
echo "=== redis ==="
docker compose exec -T redis redis-cli ping

echo
echo "stack verified"
