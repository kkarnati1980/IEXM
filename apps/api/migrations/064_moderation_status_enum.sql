-- 064: moderation_status enum — 9-state transition model per CR-VENDOR §14.1
CREATE TYPE moderation_status AS ENUM (
  'draft',
  'submitted',
  'under_review',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
  'discarded'
);

INSERT INTO schema_migrations (version)
  VALUES ('064_moderation_status_enum') ON CONFLICT DO NOTHING;
