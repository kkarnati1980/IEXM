CREATE TABLE IF NOT EXISTS iot_integration_health_statuses (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  overall_status TEXT NOT NULL CHECK (overall_status IN ('healthy', 'warning', 'critical', 'failed')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('certified', 'failed', 'unknown')),
  contract_version TEXT,
  environment TEXT,
  build_version TEXT,
  stale_after_seconds INTEGER NOT NULL DEFAULT 900,
  warning_count INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iot_integration_health_statuses_integration_event
ON iot_integration_health_statuses (integration_name, tenant_id, event_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON iot_integration_health_statuses TO app_runtime;

ALTER TABLE iot_integration_health_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_integration_health_statuses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iot_integration_health_statuses_tenant_isolation ON iot_integration_health_statuses;
CREATE POLICY iot_integration_health_statuses_tenant_isolation ON iot_integration_health_statuses
USING (tenant_id = current_setting('app.tenant_id', true))
WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
