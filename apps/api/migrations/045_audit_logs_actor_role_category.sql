-- Migration 045: Add actor_role_category to audit_logs and backfill existing rows
-- Note: audit_logs uses actor_id (not actor_user_id) and users.role (no separate roles table)

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_role_category TEXT NOT NULL DEFAULT 'system'
    CHECK (actor_role_category IN ('internal_platform','organizer_action','attendee_action','system'));

-- Backfill: classify existing rows based on the user's role at time of query
-- platform_admin and ops_user → internal_platform
-- organizer_admin, vendor_manager, sponsor_user → organizer_action
-- system actor or no matching user → system (already the default)
UPDATE audit_logs al
SET actor_role_category = CASE
  WHEN al.actor_type = 'system' THEN 'system'
  WHEN EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = al.actor_id
    AND u.role IN ('platform_admin','ops_user')
  ) THEN 'internal_platform'
  WHEN al.actor_type = 'user' THEN 'organizer_action'
  ELSE 'system'
END
WHERE al.actor_role_category = 'system';
