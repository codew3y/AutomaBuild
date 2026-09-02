#!/usr/bin/env bash
# Bring the database up and wait until it answers.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d
echo -n "waiting for postgres "
for _ in $(seq 1 90); do
  if docker compose exec -T postgres pg_isready -U webhookgate -d webhookgate >/dev/null 2>&1; then
    echo "ready"
    exit 0
  fi
  echo -n "."
  sleep 1
done
echo "timed out"
docker compose logs postgres --tail 30
exit 1
