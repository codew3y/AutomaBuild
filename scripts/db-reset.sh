#!/usr/bin/env bash
# Destroy and rebuild the development database, then wait until it is usable.
#
# Run through WSL, where the Docker daemon lives:
#   wsl.exe -e bash scripts/db-reset.sh
#
# Inline `docker compose` invocations through PowerShell are unreliable — quote
# handling mangles them and the working directory does not always survive — so
# anything non-trivial lives in a script.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "tearing down (including volumes)"
docker compose down -v

echo "starting"
docker compose up -d

echo -n "waiting for postgres "
for _ in $(seq 1 90); do
  if docker compose exec -T postgres pg_isready -U automa -d automa >/dev/null 2>&1; then
    echo "ready"
    exit 0
  fi
  echo -n "."
  sleep 1
done

echo "timed out"
docker compose logs postgres --tail 30
exit 1
