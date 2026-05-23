-- 063: organizer_import_staff sub-role + bulk_import registration source
ALTER TABLE user_role_assignments DROP CONSTRAINT IF EXISTS user_role_assignments_role_check;
ALTER TABLE user_role_assignments ADD CONSTRAINT user_role_assignments_role_check
  CHECK (role IN ('platform_admin','organizer_admin','vendor_manager','sponsor_user','ops_user','organizer_import_staff'));

ALTER TABLE attendees DROP CONSTRAINT IF EXISTS attendees_registration_source_check;
ALTER TABLE attendees ADD CONSTRAINT attendees_registration_source_check
  CHECK (registration_source IN ('nfc_tap','walk_in','bulk_import','self_register','import','api'));

INSERT INTO schema_migrations (version) VALUES ('063_import_staff_role') ON CONFLICT DO NOTHING;
