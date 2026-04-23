CREATE TABLE IF NOT EXISTS communication_suppressions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  attendee_id TEXT REFERENCES attendees(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'consent_revoke',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE communication_suppressions TO app_runtime;

ALTER TABLE communication_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS communication_suppressions_tenant_isolation ON communication_suppressions;
CREATE POLICY communication_suppressions_tenant_isolation ON communication_suppressions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
