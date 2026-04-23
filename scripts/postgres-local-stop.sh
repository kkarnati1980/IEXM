#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_DATA_DIR="${PG_DATA_DIR:-$ROOT_DIR/.local/postgres}"
PG_BIN_DIR="${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@16/bin}"

if [[ ! -f "$PG_DATA_DIR/PG_VERSION" ]]; then
  echo "Postgres data directory not initialized: $PG_DATA_DIR"
  exit 1
fi

"$PG_BIN_DIR/pg_ctl" -D "$PG_DATA_DIR" stop

