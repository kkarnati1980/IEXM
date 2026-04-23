CREATE TABLE IF NOT EXISTS iot_device_status_snapshots (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  platform_event_id TEXT REFERENCES events(id),
  platform_stall_id TEXT REFERENCES stalls(id),
  platform_assignment_checksum TEXT,
  iot_event_id TEXT REFERENCES events(id),
  iot_stall_id TEXT REFERENCES stalls(id),
  iot_assignment_checksum TEXT,
  lease_expires_at TIMESTAMPTZ,
  assignment_status TEXT NOT NULL CHECK (assignment_status IN ('matched', 'mismatched', 'missing', 'error')),
  diagnostics_status TEXT NOT NULL CHECK (diagnostics_status IN ('healthy', 'degraded', 'error', 'unknown')),
  connectivity_status TEXT,
  reader_status TEXT,
  app_version TEXT,
  firmware_version TEXT,
  local_queue_depth INTEGER,
  last_heartbeat_at TIMESTAMPTZ,
  open_incident_code TEXT,
  open_incident_status TEXT,
  open_incident_severity TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iot_device_status_snapshots_integration_device
ON iot_device_status_snapshots (integration_name, device_id);

CREATE INDEX IF NOT EXISTS idx_iot_device_status_snapshots_tenant_event
ON iot_device_status_snapshots (tenant_id, event_id, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON iot_device_status_snapshots TO app_runtime;

ALTER TABLE iot_device_status_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE iot_device_status_snapshots FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iot_device_status_snapshots_tenant_isolation ON iot_device_status_snapshots;
CREATE POLICY iot_device_status_snapshots_tenant_isolation ON iot_device_status_snapshots
USING (tenant_id = current_setting('app.tenant_id', true))
WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
