CREATE TABLE IF NOT EXISTS final_launch_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  approver_role TEXT NOT NULL CHECK (approver_role IN ('platform_admin','organizer_owner','security_owner','business_owner')),
  approver_label TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected')),
  note TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, event_id, approver_role)
);

CREATE INDEX IF NOT EXISTS idx_final_launch_approvals_event_role
ON final_launch_approvals (tenant_id, event_id, approver_role);

GRANT SELECT, INSERT, UPDATE ON final_launch_approvals TO app_runtime;

ALTER TABLE final_launch_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE final_launch_approvals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS final_launch_approvals_tenant_isolation ON final_launch_approvals;
CREATE POLICY final_launch_approvals_tenant_isolation ON final_launch_approvals
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
