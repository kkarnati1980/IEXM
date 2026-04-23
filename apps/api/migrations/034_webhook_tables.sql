-- 034_webhook_tables.sql
-- Migration: Persistent webhook infrastructure  (DM-17)
--
-- Creates:
--   webhook_subscriptions  — one row per registered webhook endpoint per tenant
--   webhook_deliveries     — delivery audit log (one row per fire attempt)
--
-- Place this file at:  apps/api/migrations/034_webhook_tables.sql
-- Run with:            node apps/api/migrate.mjs  (or your existing migration runner)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── webhook_subscriptions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            TEXT            NOT NULL,
  event_id             TEXT            NOT NULL,

  -- Destination
  target_url           TEXT            NOT NULL,
  secret_hash          TEXT            NULL,        -- SHA-256 of the caller's secret

  -- Which events fire this webhook (JSON array of strings)
  -- e.g. '["interaction.created","export.ready"]'
  event_types          JSONB           NOT NULL DEFAULT '[]'::JSONB,

  -- Lifecycle
  status               TEXT            NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','inactive','suspended')),
  failure_count        INTEGER         NOT NULL DEFAULT 0,
  last_fired_at        TIMESTAMPTZ     NULL,
  last_success_at      TIMESTAMPTZ     NULL,

  -- Audit
  created_by_user_id   TEXT            NULL,
  created_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Tenant + event lookup (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_tenant_event
  ON webhook_subscriptions (tenant_id, event_id);

-- Active-only lookup for the dispatch hot path
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_active
  ON webhook_subscriptions (tenant_id, event_id, status)
  WHERE status = 'active';

COMMENT ON TABLE  webhook_subscriptions                    IS 'Registered webhook endpoints per tenant. Spec §DM-17.';
COMMENT ON COLUMN webhook_subscriptions.event_types        IS 'JSON array of event type strings that trigger this webhook.';
COMMENT ON COLUMN webhook_subscriptions.secret_hash        IS 'SHA-256 of caller-provided HMAC secret. Used to sign delivery payloads.';
COMMENT ON COLUMN webhook_subscriptions.failure_count      IS 'Consecutive delivery failures. Auto-suspend at threshold.';


-- ── webhook_deliveries ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id      UUID            NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,

  -- What fired
  event_type           TEXT            NOT NULL,   -- e.g. "interaction.created"
  payload_event_id     TEXT            NULL,        -- ID of the source entity (interaction, export, etc.)

  -- Delivery outcome
  status               TEXT            NOT NULL
                         CHECK (status IN ('delivered','failed','pending','skipped')),
  http_status          INTEGER         NULL,        -- HTTP response code from target
  attempt_number       INTEGER         NOT NULL DEFAULT 1,
  error_message        TEXT            NULL,

  -- Timing
  fired_at             TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  responded_at         TIMESTAMPTZ     NULL,
  duration_ms          INTEGER         NULL
);

-- Per-subscription delivery history (most recent first)
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, fired_at DESC);

-- Failed deliveries for retry queue
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_failed
  ON webhook_deliveries (subscription_id, status)
  WHERE status = 'failed';

-- Event-type breakdown for analytics
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_type
  ON webhook_deliveries (subscription_id, event_type);

COMMENT ON TABLE  webhook_deliveries                         IS 'Full delivery audit log for all webhook fire attempts. Spec §DM-17.';
COMMENT ON COLUMN webhook_deliveries.attempt_number          IS 'Monotonically increasing retry counter per (subscription, payload_event_id).';
COMMENT ON COLUMN webhook_deliveries.payload_event_id        IS 'Source entity ID that triggered the delivery (interaction ID, export ID, etc.).';


-- ── Auto-suspend trigger ───────────────────────────────────────────────────
-- Suspends a webhook subscription automatically after 10 consecutive failures.

CREATE OR REPLACE FUNCTION fn_webhook_auto_suspend()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only apply on failed delivery inserts
  IF NEW.status = 'failed' THEN
    UPDATE webhook_subscriptions
       SET failure_count = failure_count + 1,
           status = CASE
             WHEN failure_count + 1 >= 10 THEN 'suspended'
             ELSE status
           END
     WHERE id = NEW.subscription_id;
  ELSIF NEW.status = 'delivered' THEN
    -- Reset failure counter on success
    UPDATE webhook_subscriptions
       SET failure_count   = 0,
           last_success_at = NEW.fired_at
     WHERE id = NEW.subscription_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_webhook_auto_suspend ON webhook_deliveries;
CREATE TRIGGER trg_webhook_auto_suspend
  AFTER INSERT ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION fn_webhook_auto_suspend();

COMMENT ON FUNCTION fn_webhook_auto_suspend() IS
  'Increments failure_count and suspends subscription after 10 consecutive failures. Resets on successful delivery.';


-- ── Seed: allowed event types reference ───────────────────────────────────
-- (Reference table — no FK on webhook_subscriptions.event_types for flexibility)

CREATE TABLE IF NOT EXISTS webhook_event_types (
  type_key      TEXT  PRIMARY KEY,
  description   TEXT  NOT NULL,
  is_active     BOOL  NOT NULL DEFAULT TRUE
);

INSERT INTO webhook_event_types (type_key, description) VALUES
  ('interaction.created',  'Fired when a new tap/interaction is recorded by the kiosk runtime.'),
  ('interaction.synced',   'Fired when an interaction has been synced to the cloud queue.'),
  ('export.ready',         'Fired when a sponsor or organizer export has been generated.'),
  ('consent.updated',      'Fired when an attendee updates their consent preferences.'),
  ('event.frozen',         'Fired when an organizer freezes the official event report.'),
  ('event.unfrozen',       'Fired when an organizer unfreezes an event report.')
ON CONFLICT (type_key) DO NOTHING;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (copy/paste to undo this migration):
-- ─────────────────────────────────────────────────────────────────────────────
--
--   BEGIN;
--   DROP TRIGGER  IF EXISTS trg_webhook_auto_suspend  ON webhook_deliveries;
--   DROP FUNCTION IF EXISTS fn_webhook_auto_suspend();
--   DROP TABLE    IF EXISTS webhook_deliveries;
--   DROP TABLE    IF EXISTS webhook_subscriptions;
--   DROP TABLE    IF EXISTS webhook_event_types;
--   COMMIT;
--
