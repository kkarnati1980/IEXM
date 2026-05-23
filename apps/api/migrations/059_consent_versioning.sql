-- P0-B1/B2/B3/B4: consent_versions, extend consents, consent_snapshots, consent_attribute_changes

-- B1: consent_versions table
CREATE TABLE IF NOT EXISTS consent_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  version_number INTEGER NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_period_days INTEGER NOT NULL DEFAULT 365,
  grievance_officer_email TEXT NOT NULL,
  data_residency_zones TEXT[] NOT NULL DEFAULT '{}',
  is_cross_border_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_consent_versions_tenant ON consent_versions(tenant_id);
ALTER TABLE consent_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_versions_tenant ON consent_versions USING (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON consent_versions TO app_runtime;

-- B2: extend consents table
ALTER TABLE consents
  ADD COLUMN IF NOT EXISTS organizer_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS consent_version_id TEXT REFERENCES consent_versions(id);

-- B3: consent_snapshots table
CREATE TABLE IF NOT EXISTS consent_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  consent_version_id TEXT REFERENCES consent_versions(id),
  vendor_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  sponsor_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  organizer_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locale TEXT NOT NULL DEFAULT 'en'
);
CREATE INDEX IF NOT EXISTS idx_consent_snapshots_interaction ON consent_snapshots(interaction_id);
CREATE INDEX IF NOT EXISTS idx_consent_snapshots_tenant ON consent_snapshots(tenant_id);
ALTER TABLE consent_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_snapshots_tenant ON consent_snapshots USING (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON consent_snapshots TO app_runtime;

-- B4: consent_attribute_changes table
CREATE TABLE IF NOT EXISTS consent_attribute_changes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  changed_by_user_id TEXT REFERENCES users(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attribute TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_attr_changes_interaction ON consent_attribute_changes(interaction_id);
CREATE INDEX IF NOT EXISTS idx_consent_attr_changes_tenant ON consent_attribute_changes(tenant_id);
ALTER TABLE consent_attribute_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_attr_changes_tenant ON consent_attribute_changes USING (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON consent_attribute_changes TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('059_consent_versioning') ON CONFLICT (version) DO NOTHING;
