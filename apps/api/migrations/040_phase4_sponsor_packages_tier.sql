-- Phase 4 follow-up: add tier column to sponsor_packages table
-- Tier was stored in-memory only during Phase 4 implementation.

ALTER TABLE sponsor_packages
  ADD COLUMN IF NOT EXISTS tier TEXT
    CHECK (tier IN ('bronze','silver','gold','custom'))
    DEFAULT 'bronze';

INSERT INTO schema_migrations (version) VALUES ('040_phase4_sponsor_packages_tier')
  ON CONFLICT (version) DO NOTHING;
