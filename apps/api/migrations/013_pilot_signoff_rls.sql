GRANT SELECT, INSERT, UPDATE ON TABLE
  pilot_dry_run_records,
  pilot_signoff_approvals
TO app_runtime;

ALTER TABLE pilot_dry_run_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_dry_run_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pilot_dry_run_records_tenant_isolation ON pilot_dry_run_records;
CREATE POLICY pilot_dry_run_records_tenant_isolation ON pilot_dry_run_records
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE pilot_signoff_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pilot_signoff_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pilot_signoff_approvals_tenant_isolation ON pilot_signoff_approvals;
CREATE POLICY pilot_signoff_approvals_tenant_isolation ON pilot_signoff_approvals
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
