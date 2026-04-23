#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_DATA_DIR="${PG_DATA_DIR:-$ROOT_DIR/.local/postgres}"
PG_SOCKET_DIR="${PG_SOCKET_DIR:-/tmp/pilot-pg}"
PG_PORT="${PG_PORT:-5432}"
PG_BIN_DIR="${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@16/bin}"
PG_USER="${PG_USER:-pilot}"
PG_LOG_FILE="${PG_LOG_FILE:-$PG_DATA_DIR/postgres.log}"

mkdir -p "$PG_SOCKET_DIR"

if [[ ! -f "$PG_DATA_DIR/PG_VERSION" ]]; then
  mkdir -p "$PG_DATA_DIR"
  "$PG_BIN_DIR/initdb" -D "$PG_DATA_DIR" --username="$PG_USER" --auth=trust
fi

if "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA_DIR" status >/dev/null 2>&1; then
  echo "Postgres already running"
  exit 0
fi

"$PG_BIN_DIR/pg_ctl" \
  -D "$PG_DATA_DIR" \
  -l "$PG_LOG_FILE" \
  -o "-p $PG_PORT -h 127.0.0.1 -k $PG_SOCKET_DIR" \
  start

echo "Postgres started on 127.0.0.1:$PG_PORT"

