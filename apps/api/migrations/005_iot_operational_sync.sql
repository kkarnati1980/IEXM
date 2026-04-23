ALTER TABLE device_heartbeats
ADD COLUMN IF NOT EXISTS assignment_checksum TEXT,
ADD COLUMN IF NOT EXISTS connectivity_status TEXT NOT NULL DEFAULT 'online',
ADD COLUMN IF NOT EXISTS reader_status TEXT NOT NULL DEFAULT 'connected',
ADD COLUMN IF NOT EXISTS app_version TEXT,
ADD COLUMN IF NOT EXISTS firmware_version TEXT,
ADD COLUMN IF NOT EXISTS source_cursor TEXT,
ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_heartbeats_source_cursor
ON device_heartbeats (source_cursor)
WHERE source_cursor IS NOT NULL;

ALTER TABLE device_incidents
ADD COLUMN IF NOT EXISTS stall_id TEXT REFERENCES stalls(id),
ADD COLUMN IF NOT EXISTS assignment_checksum TEXT,
ADD COLUMN IF NOT EXISTS message TEXT,
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS source_cursor TEXT,
ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_incidents_source_cursor
ON device_incidents (source_cursor)
WHERE source_cursor IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_incidents_tenant_event
ON device_incidents (tenant_id, event_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS iot_certification_statuses (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('certified', 'failed')),
  contract_version TEXT,
  environment TEXT,
  build_version TEXT,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_certified_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
