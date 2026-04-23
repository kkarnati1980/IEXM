CREATE TABLE IF NOT EXISTS iot_sync_checkpoints (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  last_cursor TEXT,
  last_contract_version TEXT,
  last_environment TEXT,
  last_build_version TEXT,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iot_sync_checkpoints_integration_stream
ON iot_sync_checkpoints (integration_name, stream_name);
