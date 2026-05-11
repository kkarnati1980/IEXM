-- Migration 055: Create nfc_readers table
-- Fixes: POST /nfc-readers returning 201 but writing nothing to DB
-- Fixes: GET /devices/:id always returning nfc_reader: null

CREATE TABLE IF NOT EXISTS nfc_readers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  model TEXT NOT NULL DEFAULT 'ACR122U',
  firmware_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nfc_readers_device
  ON nfc_readers(device_id);
CREATE INDEX IF NOT EXISTS idx_nfc_readers_tenant
  ON nfc_readers(tenant_id);

ALTER TABLE nfc_readers ENABLE ROW LEVEL SECURITY;

CREATE POLICY nfc_readers_tenant_isolation ON nfc_readers
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON nfc_readers TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('055_nfc_readers_table')
  ON CONFLICT (version) DO NOTHING;
