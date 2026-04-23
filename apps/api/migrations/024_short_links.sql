CREATE TABLE IF NOT EXISTS short_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  token_hash TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('attendee_session','export_download','wallet_pass')),
  target_id TEXT NOT NULL,
  target_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE short_links TO app_runtime;

ALTER TABLE short_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS short_links_tenant_isolation ON short_links;
CREATE POLICY short_links_tenant_isolation ON short_links
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
