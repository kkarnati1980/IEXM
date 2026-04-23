-- Migration 033: branding_assets
-- Versioned event asset registry (Clause 20 addition §7.2)
-- Each event can have multiple versioned branding records; only one is "active" at a time.

CREATE TABLE IF NOT EXISTS branding_assets (
  id                        TEXT        PRIMARY KEY,
  tenant_id                 TEXT        NOT NULL REFERENCES tenants(id),
  event_id                  TEXT        NOT NULL REFERENCES events(id),
  version                   INTEGER     NOT NULL DEFAULT 1,
  status                    TEXT        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'archived', 'draft')),

  -- Kiosk idle screen content
  idle_headline             TEXT        NOT NULL DEFAULT 'Tap your phone to connect',
  idle_sub                  TEXT        NOT NULL DEFAULT 'Hold your NFC device near the reader',
  tap_cta                   TEXT        NOT NULL DEFAULT 'Tap to exchange contact details',

  -- Sponsor creative
  sponsor_name              TEXT,
  sponsor_logo_url          TEXT,
  sponsor_cta               TEXT,

  -- Event identity
  event_logo_url            TEXT,
  primary_color             TEXT        NOT NULL DEFAULT '#38e8a6',
  background_color          TEXT        NOT NULL DEFAULT '#050d18',

  -- Attendee landing page
  attendee_landing_message  TEXT        NOT NULL DEFAULT 'Contact exchange successful',
  attendee_privacy_url      TEXT,

  -- Publishing metadata
  published_by_user_id      TEXT        REFERENCES users(id),
  note                      TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active asset per event at a time
CREATE UNIQUE INDEX IF NOT EXISTS branding_assets_active_event_idx
  ON branding_assets (tenant_id, event_id)
  WHERE status = 'active';

-- Version lookup per event
CREATE INDEX IF NOT EXISTS branding_assets_event_version_idx
  ON branding_assets (tenant_id, event_id, version DESC);

-- Row-level security: tenant isolation
ALTER TABLE branding_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY branding_assets_tenant_isolation ON branding_assets
  USING (tenant_id = current_setting('app.tenant_id', true));

COMMENT ON TABLE branding_assets IS
  'Versioned event branding assets. One active record per event. '
  'Archived when a new version is published via POST /branding/publish. '
  'Consumed by GET /events/:id/branding for kiosk boot and attendee pages.';
