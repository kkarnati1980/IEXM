-- 065: vendor_profiles shell — infrastructure only, zero content fields (Phase 0)
-- Content fields (description, logo_url, social links, etc.) added in Phase 1.
CREATE TABLE IF NOT EXISTS vendor_profiles (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   TEXT        NOT NULL REFERENCES tenants(id),
  organization_id             TEXT        NOT NULL REFERENCES organizations(id),
  currently_published_item_id UUID        NULL,  -- FK to moderation_items added after that table exists
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE vendor_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_profiles_rls ON vendor_profiles
  USING  (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE INDEX idx_vendor_profiles_org    ON vendor_profiles(organization_id);
CREATE INDEX idx_vendor_profiles_tenant ON vendor_profiles(tenant_id);

GRANT SELECT, INSERT, UPDATE ON vendor_profiles TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('065_vendor_profiles') ON CONFLICT DO NOTHING;
