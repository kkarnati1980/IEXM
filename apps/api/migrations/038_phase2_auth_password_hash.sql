-- Phase 2: Auth service extensions — add password_hash to users

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

INSERT INTO schema_migrations (version) VALUES ('038_phase2_auth_password_hash')
  ON CONFLICT (version) DO NOTHING;
