-- Rollback: 040_phase4_sponsor_packages_tier

ALTER TABLE sponsor_packages
  DROP COLUMN IF EXISTS tier;

DELETE FROM schema_migrations WHERE version = '040_phase4_sponsor_packages_tier';
