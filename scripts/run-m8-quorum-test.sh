#!/usr/bin/env bash
set -euo pipefail

compose_file="infra/compose/m8-rabbitmq-cluster.yml"
docker compose -f "$compose_file" up -d --wait
bash scripts/configure-m8-rabbitmq-cluster.sh

containers=()
for service in rabbitmq1 rabbitmq2 rabbitmq3; do
  container="$(docker compose -f "$compose_file" ps -q "$service")"
  if [[ -z "$container" ]]; then
    echo "Missing M8 RabbitMQ cluster container for $service" >&2
    exit 1
  fi
  containers+=("$container")
done

export ITERM_DATABASE_URL="${ITERM_DATABASE_URL:-postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test}"
export ITERM_TEST_RABBITMQ_CLUSTER_URLS="amqp://guest:guest@127.0.0.1:5674,amqp://guest:guest@127.0.0.1:5675,amqp://guest:guest@127.0.0.1:5676"
export ITERM_TEST_RABBITMQ_CLUSTER_CONTAINERS="$(IFS=,; echo "${containers[*]}")"

pnpm test:m8:quorum
