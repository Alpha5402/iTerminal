#!/usr/bin/env bash
set -euo pipefail

compose_file="infra/compose/m9-postgres-quorum.yml"
primary="$(docker compose -f "$compose_file" ps -q postgres-primary)"
standby1="$(docker compose -f "$compose_file" ps -q postgres-standby1)"
standby2="$(docker compose -f "$compose_file" ps -q postgres-standby2)"

if [[ -z "$primary" || -z "$standby1" || -z "$standby2" ]]; then
  echo "M9 PostgreSQL quorum containers are not running" >&2
  exit 1
fi

for standby in "$standby1" "$standby2"; do
  recovery="$(docker exec "$standby" psql -U iterminal -d iterminal_test -Atc "SELECT pg_is_in_recovery()")"
  if [[ "$recovery" != "t" ]]; then
    echo "M9 PostgreSQL standby is not in recovery: $standby" >&2
    exit 1
  fi
done

docker exec "$primary" psql -v ON_ERROR_STOP=1 -U iterminal -d iterminal_test -c \
  "ALTER SYSTEM SET synchronous_standby_names TO 'ANY 1 (standby1, standby2)'"
docker exec "$primary" psql -v ON_ERROR_STOP=1 -U iterminal -d iterminal_test -c \
  "ALTER SYSTEM SET synchronous_commit TO 'remote_apply'"
docker exec "$primary" psql -v ON_ERROR_STOP=1 -U iterminal -d iterminal_test -c \
  "SELECT pg_reload_conf()"

docker exec --user postgres "$standby1" sh -c \
  "printf '%s\n' \"synchronous_standby_names = 'ANY 1 (standby2)'\" \"synchronous_commit = 'remote_apply'\" >> \"\$PGDATA/postgresql.auto.conf\""
docker exec --user postgres "$standby2" sh -c \
  "printf '%s\n' \"synchronous_standby_names = 'ANY 1 (standby1)'\" \"synchronous_commit = 'remote_apply'\" >> \"\$PGDATA/postgresql.auto.conf\""
docker exec --user postgres "$standby1" pg_ctl -D /var/lib/postgresql/data reload
docker exec --user postgres "$standby2" pg_ctl -D /var/lib/postgresql/data reload

for _ in $(seq 1 60); do
  streaming="$(docker exec "$primary" psql -U iterminal -d iterminal_test -Atc \
    "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming' AND sync_state = 'quorum'")"
  if [[ "$streaming" = "2" ]]; then
    docker exec "$primary" psql -U iterminal -d iterminal_test -c \
      "SELECT application_name, state, sync_state FROM pg_stat_replication ORDER BY application_name"
    exit 0
  fi
  sleep 1
done

echo "M9 PostgreSQL standbys did not enter quorum streaming state" >&2
exit 1
