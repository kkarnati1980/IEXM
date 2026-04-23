CREATE TABLE IF NOT EXISTS iot_integration_runs (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('manual', 'scheduled', 'automation', 'test')),
  initiated_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_warnings', 'failed')),
  step_count INTEGER NOT NULL DEFAULT 0,
  failed_step_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iot_integration_runs_tenant_event_started
ON iot_integration_runs (tenant_id, event_id, started_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON iot_integration_runs TO app_runtime;

ALTER TABLE iot_integration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_integration_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iot_integration_runs_tenant_isolation ON iot_integration_runs;
CREATE POLICY iot_integration_runs_tenant_isolation ON iot_integration_runs
USING (tenant_id = current_setting('app.tenant_id', true))
WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
