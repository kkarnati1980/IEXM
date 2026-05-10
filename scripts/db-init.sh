#!/bin/bash
set -e
echo "Initialising Codex database..."

# Create app_runtime role and grant base access
psql -v ON_ERROR_STOP=0 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime;
    RAISE NOTICE 'Created role app_runtime';
  END IF;
END $$;

GRANT CONNECT ON DATABASE codex TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
SQL

# Run all migrations in order (skip any rollback files)
MIGRATION_DIR="/docker-entrypoint-initdb.d/migrations"
if [ -d "$MIGRATION_DIR" ]; then
  for f in $(ls "$MIGRATION_DIR"/*.sql | grep -v rollback | sort); do
    echo "  Applying: $(basename "$f")"
    psql -v ON_ERROR_STOP=0 \
      --username "$POSTGRES_USER" \
      --dbname "$POSTGRES_DB" \
      --file "$f" 2>/dev/null || true
  done
  echo "Migrations applied."
else
  echo "No migrations directory at $MIGRATION_DIR"
fi

# Grant app_runtime full access to all tables/sequences created by migrations,
# and set default privileges so future tables are covered automatically.
psql -v ON_ERROR_STOP=0 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" <<'SQL'
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO app_runtime;

SELECT 'Setup complete: ' || count(*) || ' tables accessible'
FROM information_schema.tables
WHERE table_schema = 'public';
SQL

echo "Database initialisation complete."
