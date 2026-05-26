-- Rollback 070: vendor_profile_social_links
DROP TABLE IF EXISTS vendor_profile_social_links;
DROP INDEX IF EXISTS vendor_profiles_org_unique;
DELETE FROM schema_migrations WHERE version = '070_vendor_profile_social_links';
