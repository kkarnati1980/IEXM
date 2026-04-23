DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  snapshot_version INTEGER NOT NULL,
  calculation_version INTEGER NOT NULL DEFAULT 1,
  snapshot_interval_minutes INTEGER NOT NULL DEFAULT 5,
  payload JSONB NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_tenant_event_created
  ON leaderboard_snapshots(tenant_id, event_id, created_at DESC);

GRANT SELECT, INSERT ON TABLE leaderboard_snapshots TO app_runtime;

ALTER TABLE leaderboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaderboard_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leaderboard_snapshots_tenant_isolation ON leaderboard_snapshots;
CREATE POLICY leaderboard_snapshots_tenant_isolation ON leaderboard_snapshots
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
