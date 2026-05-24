-- 069: user content flags per CR-VENDOR §15.2
-- vendor_content_editor: user may submit items for moderation review
-- vendor_content_approver: user may approve/reject/request_changes (subject to editor≠approver guard)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS vendor_content_editor   BOOL NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS vendor_content_approver BOOL NOT NULL DEFAULT FALSE;

-- Backfill: all existing vendor_manager users get both flags enabled.
-- Note: spec references a JOIN to a roles table, but user_role_assignments uses a
-- direct role TEXT column — backfill from users.role directly.
UPDATE users
   SET vendor_content_editor   = TRUE,
       vendor_content_approver = TRUE
 WHERE role = 'vendor_manager';

INSERT INTO schema_migrations (version)
  VALUES ('069_user_content_flags') ON CONFLICT DO NOTHING;
