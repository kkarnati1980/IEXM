-- 062: NFC tag batch management
CREATE TABLE IF NOT EXISTS nfc_tag_batches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  label TEXT NOT NULL,
  pass_type_id TEXT REFERENCES pass_types(id),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  issued_by_user_id TEXT REFERENCES users(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nfc_tag_batches_tenant_event_idx
  ON nfc_tag_batches (tenant_id, event_id);

ALTER TABLE nfc_tag_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY nfc_tag_batches_tenant_isolation ON nfc_tag_batches
  USING (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON nfc_tag_batches TO app_runtime;

CREATE TABLE IF NOT EXISTS nfc_tag_batch_uids (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  batch_id TEXT NOT NULL REFERENCES nfc_tag_batches(id) ON DELETE CASCADE,
  nfc_uid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pre_registered'
    CHECK (status IN ('pre_registered','active','returned')),
  assigned_to_attendee_id TEXT REFERENCES attendees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nfc_uid)
);

CREATE INDEX IF NOT EXISTS nfc_tag_batch_uids_batch_idx
  ON nfc_tag_batch_uids (batch_id);

CREATE INDEX IF NOT EXISTS nfc_tag_batch_uids_nfc_uid_idx
  ON nfc_tag_batch_uids (tenant_id, nfc_uid);

ALTER TABLE nfc_tag_batch_uids ENABLE ROW LEVEL SECURITY;

CREATE POLICY nfc_tag_batch_uids_tenant_isolation ON nfc_tag_batch_uids
  USING (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON nfc_tag_batch_uids TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('062_nfc_tag_batches') ON CONFLICT DO NOTHING;
