-- Migration 057: Create pass_types table
-- Defines attendee pass categories with NFC behaviour control.
-- nfc_behaviour: consent = show consent screen (default),
--   skip = silent staff access (no interaction created),
--   access_only = log entry without consent screen.

CREATE TABLE IF NOT EXISTS pass_types (
  id              TEXT        PRIMARY KEY,
  tenant_id       TEXT        NOT NULL REFERENCES tenants(id),
  event_id        TEXT        NOT NULL REFERENCES events(id),
  name            TEXT        NOT NULL,
  code            TEXT        NOT NULL,
  colour_hex      TEXT        NOT NULL DEFAULT '#6B7280',
  nfc_behaviour   TEXT        NOT NULL DEFAULT 'consent'
    CHECK (nfc_behaviour IN ('consent', 'skip', 'access_only')),
  vendor_visible  BOOLEAN     NOT NULL DEFAULT TRUE,
  quantity_issued INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE INDEX IF NOT EXISTS idx_pass_types_event
  ON pass_types(event_id);
CREATE INDEX IF NOT EXISTS idx_pass_types_tenant
  ON pass_types(tenant_id);

ALTER TABLE pass_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY pass_types_tenant_isolation ON pass_types
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON pass_types TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('057_pass_types')
  ON CONFLICT (version) DO NOTHING;
