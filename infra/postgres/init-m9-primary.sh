#!/usr/bin/env sh
set -eu

printf '%s\n' 'host replication all all trust' >> "$PGDATA/pg_hba.conf"
