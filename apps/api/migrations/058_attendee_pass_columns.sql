-- P0-A2/A3/A4/B6: add pass_type_id FK, registration_source, nfc_batch_id, age_confirmed_18_plus to attendees

ALTER TABLE attendees
  ADD COLUMN IF NOT EXISTS pass_type_id TEXT REFERENCES pass_types(id),
  ADD COLUMN IF NOT EXISTS registration_source TEXT NOT NULL DEFAULT 'import'
    CHECK (registration_source IN ('import','walk_in','api')),
  ADD COLUMN IF NOT EXISTS nfc_batch_id TEXT,
  ADD COLUMN IF NOT EXISTS age_confirmed_18_plus BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_attendees_pass_type_id ON attendees(pass_type_id) WHERE pass_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendees_registration_source ON attendees(registration_source);

INSERT INTO schema_migrations (version) VALUES ('058_attendee_pass_columns') ON CONFLICT (version) DO NOTHING;
