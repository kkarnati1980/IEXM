CREATE TABLE IF NOT EXISTS wallet_passes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  pass_type TEXT NOT NULL CHECK (pass_type IN ('apple','google','generic')),
  status TEXT NOT NULL CHECK (status IN ('disabled','generated','delivered','failed','cancelled')),
  artifact_ref TEXT,
  short_link_id TEXT REFERENCES short_links(id),
  failure_code TEXT,
  failure_message TEXT,
  requested_by_user_id TEXT REFERENCES users(id),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_pass_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  wallet_pass_id TEXT NOT NULL REFERENCES wallet_passes(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('disabled','generated','failed')),
  reason TEXT NOT NULL CHECK (reason IN ('create','retry')),
  pass_type TEXT NOT NULL CHECK (pass_type IN ('apple','google','generic')),
  artifact_ref TEXT,
  short_link_id TEXT REFERENCES short_links(id),
  failure_code TEXT,
  failure_message TEXT,
  attempted_by_user_id TEXT REFERENCES users(id),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE wallet_passes TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE wallet_pass_attempts TO app_runtime;

ALTER TABLE wallet_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_passes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_passes_tenant_isolation ON wallet_passes;
CREATE POLICY wallet_passes_tenant_isolation ON wallet_passes
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE wallet_pass_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_pass_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_pass_attempts_tenant_isolation ON wallet_pass_attempts;
CREATE POLICY wallet_pass_attempts_tenant_isolation ON wallet_pass_attempts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
