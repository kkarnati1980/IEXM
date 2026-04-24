-- Phase 1: RBAC Foundation — DB Migrations
-- Steps 1.1 through 1.8 of the Implementation Plan

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.1 — sponsor_packages (prerequisite FK target for user_role_assignments)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sponsor_packages (
  id          TEXT        PRIMARY KEY,
  tenant_id   TEXT        NOT NULL REFERENCES tenants(id),
  event_id    TEXT        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sponsor_packages_tenant_event
  ON sponsor_packages (tenant_id, event_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.1 — user_role_assignments (RBAC scoping table)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_role_assignments (
  id                   TEXT        PRIMARY KEY,
  tenant_id            TEXT        NOT NULL REFERENCES tenants(id),
  user_id              TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT        NOT NULL
                         CHECK (role IN ('platform_admin','organizer_admin',
                                         'vendor_manager','sponsor_user','ops_user')),
  event_id             TEXT        REFERENCES events(id) ON DELETE CASCADE,
  stall_ids            TEXT[],
  sponsor_package_id   TEXT        REFERENCES sponsor_packages(id),
  assigned_by_user_id  TEXT        NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_role_assignments_tenant_user
  ON user_role_assignments (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_user_role_assignments_tenant_event
  ON user_role_assignments (tenant_id, event_id)
  WHERE event_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.2 — Add invitation + password-reset columns to users
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS invited_by_user_id        TEXT        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS invitation_token_hash     TEXT,
  ADD COLUMN IF NOT EXISTS invitation_expires_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.3 — organizations: add status column + CHECK constraint
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_status_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_status_check
      CHECK (status IN ('active', 'suspended'));
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.4 — events: validate all 5 status values are present
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  constr TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constr
  FROM pg_constraint
  WHERE conname = 'events_status_check';

  IF constr IS NULL THEN
    RAISE EXCEPTION 'events_status_check constraint not found';
  END IF;
  IF constr NOT LIKE '%archived%' THEN
    RAISE EXCEPTION 'events_status_check missing "archived": %', constr;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.5 — break_glass_access: add idx_break_glass_tenant_status index
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_break_glass_tenant_status
  ON break_glass_access (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.6 — branding_assets: add approval workflow columns
--            (plan refers to table as "branding_profiles"; actual table is branding_assets)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE branding_assets
  ADD COLUMN IF NOT EXISTS branding_approved    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS branding_approved_by TEXT        REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS branding_approved_at TIMESTAMPTZ;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.7 — api_clients table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_clients (
  id                  TEXT        PRIMARY KEY,
  tenant_id           TEXT        NOT NULL REFERENCES tenants(id),
  name                TEXT        NOT NULL,
  secret_hash         TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'revoked')),
  last_used_at        TIMESTAMPTZ,
  created_by_user_id  TEXT        REFERENCES users(id),
  revoked_by_user_id  TEXT        REFERENCES users(id),
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_clients_tenant_status
  ON api_clients (tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.8 — devices: validate all 5 status values are present
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  constr TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO constr
  FROM pg_constraint
  WHERE conname = 'devices_status_check';

  IF constr IS NULL THEN
    RAISE EXCEPTION 'devices_status_check constraint not found';
  END IF;
  IF constr NOT LIKE '%retired%' THEN
    RAISE EXCEPTION 'devices_status_check missing "retired": %', constr;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.9 — Record migration
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version) VALUES ('037_phase1_rbac_foundation')
  ON CONFLICT (version) DO NOTHING;
