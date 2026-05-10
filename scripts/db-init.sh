#!/bin/bash
# Runs all migrations in order on first PostgreSQL container start.
set -e

echo "Running Codex database migrations..."

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime;
    RAISE NOTICE 'Created role app_runtime';
  END IF;
END
$$;
GRANT CONNECT ON DATABASE codex TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
SQL

MIGRATION_DIR="/docker-entrypoint-initdb.d/migrations"
if [ -d "$MIGRATION_DIR" ]; then
  for migration in $(ls "$MIGRATION_DIR"/*.sql 2>/dev/null | sort); do
    filename=$(basename "$migration")
    echo "  Applying: $filename"
    psql -v ON_ERROR_STOP=1 \
         --username "$POSTGRES_USER" \
         --dbname "$POSTGRES_DB" \
         --file "$migration" || echo "  Warning: $filename may already be applied — continuing"
  done
  echo "Migrations complete."
else
  echo "No migrations directory at $MIGRATION_DIR"
fi
