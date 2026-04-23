#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/.backups/postgres}"
PG_BIN_DIR="${PG_BIN_DIR:-/opt/homebrew/opt/postgresql@16/bin}"
DATABASE_URL="${DATABASE_URL:-postgres://pilot@127.0.0.1:5432/pilot_platform}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="$BACKUP_DIR/pilot-platform-$STAMP.dump"

"$PG_BIN_DIR/pg_dump" --format=custom --file="$OUTPUT_FILE" "$DATABASE_URL"

echo "$OUTPUT_FILE"

