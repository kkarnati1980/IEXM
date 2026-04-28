-- Migration 052: Grant app_runtime access to tables added after migration 003
-- These tables were created in later migrations but never received GRANT statements.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  user_role_assignments,
  sponsor_packages,
  api_clients,
  branding_assets,
  crm_connections,
  crm_sync_jobs,
  enrichment_requests,
  enrichment_results,
  export_worker_queue,
  iot_certification_statuses,
  iot_sync_checkpoints,
  webhook_deliveries,
  webhook_event_types,
  webhook_subscriptions
TO app_runtime;

-- tenant_offboarding_jobs and audit_log variants: SELECT + INSERT only (append-only audit pattern)
GRANT SELECT, INSERT ON TABLE
  tenant_offboarding_jobs,
  privacy_audit_log
TO app_runtime;

-- schema_migrations and tenants: read-only for app_runtime
GRANT SELECT ON TABLE
  schema_migrations,
  tenants
TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('052_grant_app_runtime_missing_tables')
  ON CONFLICT (version) DO NOTHING;
