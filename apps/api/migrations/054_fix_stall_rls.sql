-- Migration 054: Fix RLS policies on stall drive tables
-- Migration 053 incorrectly used current_setting('app.current_tenant_id', true)
-- instead of the app_current_tenant_id() function which reads app.tenant_id.
-- This caused all queries as app_runtime to return zero rows.

ALTER POLICY tenant_isolation_sdc ON stall_drive_connections
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER POLICY tenant_isolation_ssf ON stall_shared_folders
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER POLICY tenant_isolation_sfa ON stall_folder_access
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER POLICY tenant_isolation_sfal ON stall_folder_access_log
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

INSERT INTO schema_migrations (version) VALUES ('054_fix_stall_rls')
  ON CONFLICT (version) DO NOTHING;
