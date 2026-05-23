-- Migration 061: Add staff_exempt to consent_status CHECK
-- Required for pass types with nfc_behaviour = 'skip' or 'access_only'.
-- Using 'declined' would tag staff taps as refusals, polluting
-- consent-rate analytics. staff_exempt is the correct semantic.

DO $$
BEGIN
  ALTER TABLE interactions
    DROP CONSTRAINT IF EXISTS interactions_consent_status_check;

  ALTER TABLE interactions
    ADD CONSTRAINT interactions_consent_status_check
    CHECK (consent_status IN (
      'pending',
      'vendor_only',
      'vendor_and_sponsor',
      'declined',
      'declined_age',
      'staff_exempt'
    ));
EXCEPTION WHEN others THEN
  -- Constraint may not exist on a fresh DB — safe to continue
  NULL;
END $$;

INSERT INTO schema_migrations (version)
  VALUES ('061_consent_status_staff_exempt')
  ON CONFLICT (version) DO NOTHING;
