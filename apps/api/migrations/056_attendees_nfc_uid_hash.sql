-- Migration 056: Add nfc_uid_hash column to attendees table
-- Enables attendee lookup by NFC card UID (e.g. ACR122U on Pi 5)
-- Uses partial unique index — NULL rows are excluded from uniqueness check,
-- so all existing attendees (nfc_uid_hash = NULL) are unaffected.
-- Server lowercases raw UID before hashing. Pi 5 sends raw UID.

ALTER TABLE attendees
  ADD COLUMN IF NOT EXISTS nfc_uid_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS attendees_nfc_uid_hash_unique
  ON attendees(nfc_uid_hash)
  WHERE nfc_uid_hash IS NOT NULL;

GRANT UPDATE ON attendees TO app_runtime;

INSERT INTO schema_migrations (version) VALUES ('056_attendees_nfc_uid_hash')
  ON CONFLICT (version) DO NOTHING;
