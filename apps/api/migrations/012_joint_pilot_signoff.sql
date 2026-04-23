CREATE TABLE pilot_dry_run_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  execution_type TEXT NOT NULL CHECK (execution_type IN ('staging_go_live_dry_run')),
  status TEXT NOT NULL CHECK (status IN ('planned','running','completed','failed')),
  executed_by_user_id TEXT REFERENCES users(id),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pilot_dry_run_records_event_created_idx
ON pilot_dry_run_records (tenant_id, event_id, created_at DESC);

CREATE TABLE pilot_signoff_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  approver_role TEXT NOT NULL CHECK (approver_role IN ('organizer','platform','iot')),
  approver_label TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected')),
  note TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id, approver_role)
);

CREATE INDEX pilot_signoff_approvals_event_role_idx
ON pilot_signoff_approvals (tenant_id, event_id, approver_role);
