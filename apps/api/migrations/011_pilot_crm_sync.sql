CREATE TABLE IF NOT EXISTS crm_sync_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  provider TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('synced','delete_pending','deleted','failed')),
  external_record_id TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  synced_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_sync_records_interaction_provider
ON crm_sync_records (tenant_id, interaction_id, provider);

CREATE INDEX IF NOT EXISTS idx_crm_sync_records_tenant_event
ON crm_sync_records (tenant_id, event_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_sync_records TO app_runtime;

ALTER TABLE crm_sync_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_sync_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS crm_sync_records_tenant_isolation ON crm_sync_records;
CREATE POLICY crm_sync_records_tenant_isolation ON crm_sync_records
USING (tenant_id = app_current_tenant_id())
WITH CHECK (tenant_id = app_current_tenant_id());
