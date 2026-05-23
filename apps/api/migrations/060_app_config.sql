-- P0-B5: app_config singleton per tenant

CREATE TABLE IF NOT EXISTS app_config (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  deployment_region TEXT NOT NULL DEFAULT 'global',
  is_cross_border_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  data_controller_name TEXT NOT NULL DEFAULT '',
  grievance_officer_email TEXT NOT NULL DEFAULT '',
  retention_period_days INTEGER NOT NULL DEFAULT 365,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_config_tenant ON app_config USING (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app_config TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('060_app_config') ON CONFLICT (version) DO NOTHING;
