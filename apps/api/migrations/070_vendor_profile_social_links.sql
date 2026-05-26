-- 070: vendor_profile_social_links
-- Published social links for an approved vendor profile.
-- Draft social links live in moderation_items.payload.social_links (JSONB array).
-- On approval, the transition handler bulk-replaces rows here from the approved payload.
-- Also adds UNIQUE guard on vendor_profiles to prevent duplicate shell rows.

-- Guard: one vendor_profiles shell per org
CREATE UNIQUE INDEX IF NOT EXISTS vendor_profiles_org_unique
  ON vendor_profiles(tenant_id, organization_id);

CREATE TABLE IF NOT EXISTS vendor_profile_social_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT        NOT NULL REFERENCES tenants(id),
  vendor_profile_id UUID        NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  channel           TEXT        NOT NULL
                    CHECK (channel IN ('linkedin','youtube','instagram','facebook',
                                       'x','whatsapp','generic_1','generic_2')),
  url               TEXT        NOT NULL,
  prefilled_message TEXT,
  click_count       INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor_profile_id, channel)
);

ALTER TABLE vendor_profile_social_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY vendor_profile_social_links_rls ON vendor_profile_social_links
  USING  (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE INDEX idx_vpsl_profile ON vendor_profile_social_links(vendor_profile_id);
CREATE INDEX idx_vpsl_tenant  ON vendor_profile_social_links(tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON vendor_profile_social_links TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('070_vendor_profile_social_links') ON CONFLICT DO NOTHING;
