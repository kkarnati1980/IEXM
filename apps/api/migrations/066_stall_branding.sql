-- 066: stall_branding shell — infrastructure only, zero content fields (Phase 0)
-- Content fields (colour, logo_url, banner_url, etc.) added in Phase 1.
CREATE TABLE IF NOT EXISTS stall_branding (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   TEXT        NOT NULL REFERENCES tenants(id),
  stall_id                    TEXT        NOT NULL REFERENCES stalls(id),
  organization_id             TEXT        NOT NULL REFERENCES organizations(id),
  currently_published_item_id UUID        NULL,  -- FK to moderation_items added after that table exists
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE stall_branding ENABLE ROW LEVEL SECURITY;
CREATE POLICY stall_branding_rls ON stall_branding
  USING  (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE INDEX idx_stall_branding_stall  ON stall_branding(stall_id);
CREATE INDEX idx_stall_branding_org    ON stall_branding(organization_id);
CREATE INDEX idx_stall_branding_tenant ON stall_branding(tenant_id);

GRANT SELECT, INSERT, UPDATE ON stall_branding TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('066_stall_branding') ON CONFLICT DO NOTHING;
