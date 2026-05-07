-- Migration 053: Stall document storage via Google Drive / OneDrive
-- Provides OAuth connections, shared folder management, attendee access grants, and audit log

CREATE TABLE IF NOT EXISTS stall_drive_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  provider TEXT NOT NULL CHECK (provider IN ('google_drive','onedrive')),
  connected_by_user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  drive_account_email TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disconnected','error')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stall_shared_folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  event_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES stall_drive_connections(id),
  provider TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  folder_path TEXT,
  default_access TEXT NOT NULL DEFAULT 'open'
    CHECK (default_access IN ('open','restricted')),
  allow_download BOOLEAN NOT NULL DEFAULT true,
  allow_view BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stall_folder_access (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  stall_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES stall_shared_folders(id),
  attendee_id TEXT REFERENCES attendees(id),
  interaction_id TEXT REFERENCES interactions(id),
  access_token TEXT NOT NULL UNIQUE,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  granted_by TEXT NOT NULL DEFAULT 'auto'
    CHECK (granted_by IN ('auto','manual')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','revoked')),
  last_accessed_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT
);

CREATE TABLE IF NOT EXISTS stall_folder_access_log (
  id TEXT PRIMARY KEY DEFAULT
    'sfal-' || substr(md5(random()::text),1,12),
  tenant_id TEXT NOT NULL,
  folder_access_id TEXT NOT NULL REFERENCES stall_folder_access(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'link_opened','file_viewed','file_downloaded',
    'access_revoked','access_suspended','access_restored'
  )),
  file_id TEXT,
  file_name TEXT,
  ip_address TEXT,
  user_agent TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sdc_stall ON stall_drive_connections(stall_id);
CREATE INDEX IF NOT EXISTS idx_sdc_status ON stall_drive_connections(status);
CREATE INDEX IF NOT EXISTS idx_ssf_stall ON stall_shared_folders(stall_id);
CREATE INDEX IF NOT EXISTS idx_ssf_status ON stall_shared_folders(status);
CREATE INDEX IF NOT EXISTS idx_sfa_token ON stall_folder_access(access_token);
CREATE INDEX IF NOT EXISTS idx_sfa_attendee ON stall_folder_access(attendee_id);
CREATE INDEX IF NOT EXISTS idx_sfa_interaction ON stall_folder_access(interaction_id);
CREATE INDEX IF NOT EXISTS idx_sfa_stall ON stall_folder_access(stall_id);
CREATE INDEX IF NOT EXISTS idx_sfal_access ON stall_folder_access_log(folder_access_id);

-- Row Level Security
ALTER TABLE stall_drive_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE stall_shared_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE stall_folder_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE stall_folder_access_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_sdc ON stall_drive_connections
  USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_ssf ON stall_shared_folders
  USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_sfa ON stall_folder_access
  USING (tenant_id = current_setting('app.current_tenant_id', true));
CREATE POLICY tenant_isolation_sfal ON stall_folder_access_log
  USING (tenant_id = current_setting('app.current_tenant_id', true));

GRANT ALL ON stall_drive_connections TO app_runtime;
GRANT ALL ON stall_shared_folders TO app_runtime;
GRANT ALL ON stall_folder_access TO app_runtime;
GRANT ALL ON stall_folder_access_log TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('053_stall_drive_storage')
  ON CONFLICT (version) DO NOTHING;
