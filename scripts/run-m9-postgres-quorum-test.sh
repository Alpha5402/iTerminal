#!/usr/bin/env bash
set -euo pipefail

compose_file="infra/compose/m9-postgres-quorum.yml"
docker compose -f "$compose_file" up -d --wait
bash scripts/configure-m9-postgres-quorum.sh

containers=()
for service in postgres-primary postgres-standby1 postgres-standby2; do
  container="$(docker compose -f "$compose_file" ps -q "$service")"
  if [[ -z "$container" ]]; then
    echo "Missing M9 PostgreSQL quorum container for $service" >&2
    exit 1
  fi
  containers+=("$container")
done

export ITERM_TEST_POSTGRES_QUORUM_URLS="postgresql://iterminal:iterminal@127.0.0.1:55441/iterminal_test,postgresql://iterminal:iterminal@127.0.0.1:55442/iterminal_test,postgresql://iterminal:iterminal@127.0.0.1:55443/iterminal_test"
export ITERM_TEST_POSTGRES_QUORUM_CONTAINERS="$(IFS=,; echo "${containers[*]}")"

env -u ITERM_DATABASE_URL pnpm test:m9:postgres-quorum
