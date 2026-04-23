CREATE TABLE IF NOT EXISTS iot_alert_events (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('run','health','parity')),
  source_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('not_configured','pending','delivered','failed')),
  routed_destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_delivery_at TIMESTAMPTZ,
  delivery_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iot_alert_events_tenant_event_created
ON iot_alert_events (tenant_id, event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_iot_alert_events_tenant_event_status
ON iot_alert_events (tenant_id, event_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS iot_environment_parity_statuses (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  staging_contract_version TEXT,
  staging_environment TEXT,
  staging_build_version TEXT,
  production_contract_version TEXT,
  production_environment TEXT,
  production_build_version TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iot_environment_parity_statuses_integration_event
ON iot_environment_parity_statuses (integration_name, tenant_id, event_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON iot_alert_events TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON iot_environment_parity_statuses TO app_runtime;

ALTER TABLE iot_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_alert_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iot_alert_events_tenant_isolation ON iot_alert_events;
CREATE POLICY iot_alert_events_tenant_isolation ON iot_alert_events
USING (tenant_id = app_current_tenant_id())
WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE iot_environment_parity_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_environment_parity_statuses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iot_environment_parity_statuses_tenant_isolation ON iot_environment_parity_statuses;
CREATE POLICY iot_environment_parity_statuses_tenant_isolation ON iot_environment_parity_statuses
USING (tenant_id = app_current_tenant_id())
WITH CHECK (tenant_id = app_current_tenant_id());
