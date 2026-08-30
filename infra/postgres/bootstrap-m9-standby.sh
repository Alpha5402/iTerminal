#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  exec gosu postgres "$0" "$@"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  rm -rf "$PGDATA"/*
  until pg_isready -h postgres-primary -U iterminal -d iterminal_test >/dev/null 2>&1; do
    sleep 1
  done
  pg_basebackup \
    --dbname="host=postgres-primary port=5432 user=iterminal password=iterminal application_name=$ITERM_STANDBY_NAME" \
    --pgdata="$PGDATA" \
    --write-recovery-conf \
    --wal-method=stream
  chmod 0700 "$PGDATA"
fi

exec postgres -c hot_standby=on
