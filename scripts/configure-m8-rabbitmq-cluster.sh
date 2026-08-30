#!/usr/bin/env bash
set -euo pipefail

compose_file="infra/compose/m8-rabbitmq-cluster.yml"
primary="$(docker compose -f "$compose_file" ps -q rabbitmq1)"
second="$(docker compose -f "$compose_file" ps -q rabbitmq2)"
third="$(docker compose -f "$compose_file" ps -q rabbitmq3)"

if [[ -z "$primary" || -z "$second" || -z "$third" ]]; then
  echo "M8 RabbitMQ cluster containers are not running" >&2
  exit 1
fi

for container in "$primary" "$second" "$third"; do
  docker exec "$container" rabbitmqctl await_startup
done

for container in "$second" "$third"; do
  docker exec "$container" rabbitmqctl stop_app
  docker exec "$container" rabbitmqctl reset
  docker exec "$container" rabbitmqctl join_cluster rabbit@rabbitmq1
  docker exec "$container" rabbitmqctl start_app
done

docker exec "$primary" rabbitmqctl cluster_status
