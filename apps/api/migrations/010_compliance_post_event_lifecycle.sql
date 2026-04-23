CREATE TABLE IF NOT EXISTS data_subject_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  attendee_id TEXT REFERENCES attendees(id),
  interaction_id TEXT REFERENCES interactions(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('access','delete')),
  status TEXT NOT NULL CHECK (status IN ('requested','in_progress','completed','rejected')),
  requested_by_user_id TEXT REFERENCES users(id),
  request_reason TEXT,
  resolution_summary TEXT,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_data_subject_requests_tenant_event_created
ON data_subject_requests (tenant_id, event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS downstream_deletion_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  dsr_request_id TEXT NOT NULL REFERENCES data_subject_requests(id),
  target_system TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_downstream_deletion_records_tenant_event
ON downstream_deletion_records (tenant_id, event_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_downstream_deletion_records_request
ON downstream_deletion_records (tenant_id, dsr_request_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS compliance_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  run_type TEXT NOT NULL CHECK (run_type IN ('retention_preview','retention_apply','dsr_delete_apply')),
  status TEXT NOT NULL CHECK (status IN ('preview','completed','failed')),
  initiated_by TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_runs_tenant_event_created
ON compliance_runs (tenant_id, event_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON data_subject_requests TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON downstream_deletion_records TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_runs TO app_runtime;

ALTER TABLE data_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_subject_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_subject_requests_tenant_isolation ON data_subject_requests;
CREATE POLICY data_subject_requests_tenant_isolation ON data_subject_requests
USING (tenant_id = app_current_tenant_id())
WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE downstream_deletion_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE downstream_deletion_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS downstream_deletion_records_tenant_isolation ON downstream_deletion_records;
CREATE POLICY downstream_deletion_records_tenant_isolation ON downstream_deletion_records
USING (tenant_id = app_current_tenant_id())
WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE compliance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compliance_runs_tenant_isolation ON compliance_runs;
CREATE POLICY compliance_runs_tenant_isolation ON compliance_runs
USING (tenant_id = app_current_tenant_id())
WITH CHECK (tenant_id = app_current_tenant_id());
