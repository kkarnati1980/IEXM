-- Rollback for Phase 1: RBAC Foundation
-- Reverses 037_phase1_rbac_foundation.sql in reverse step order

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.8 rollback — validate-only step, nothing to undo
-- Step 1.7 rollback — api_clients
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_api_clients_tenant_status;
DROP TABLE IF EXISTS api_clients;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.6 rollback — branding_assets approval columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE branding_assets
  DROP COLUMN IF EXISTS branding_approved,
  DROP COLUMN IF EXISTS branding_approved_by,
  DROP COLUMN IF EXISTS branding_approved_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.5 rollback — break_glass_access index
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_break_glass_tenant_status;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.4 rollback — validate-only step, nothing to undo
-- Step 1.3 rollback — organizations status column + constraint
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_status_check,
  DROP COLUMN IF EXISTS status;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.2 rollback — users invitation + password-reset columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE users
  DROP COLUMN IF EXISTS invited_by_user_id,
  DROP COLUMN IF EXISTS invitation_token_hash,
  DROP COLUMN IF EXISTS invitation_expires_at,
  DROP COLUMN IF EXISTS password_reset_token_hash,
  DROP COLUMN IF EXISTS password_reset_expires_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1.1 rollback — user_role_assignments then sponsor_packages
-- ─────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_user_role_assignments_tenant_event;
DROP INDEX IF EXISTS idx_user_role_assignments_tenant_user;
DROP TABLE IF EXISTS user_role_assignments;

DROP INDEX IF EXISTS idx_sponsor_packages_tenant_event;
DROP TABLE IF EXISTS sponsor_packages;

-- ─────────────────────────────────────────────────────────────────────────────
-- Remove migration record
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM schema_migrations WHERE version = '037_phase1_rbac_foundation';
