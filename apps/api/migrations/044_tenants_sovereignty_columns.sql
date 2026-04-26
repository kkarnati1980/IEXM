-- Migration 044: Add sovereignty columns to tenants table

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS data_residency_zone TEXT NOT NULL DEFAULT 'global'
    CHECK (data_residency_zone IN ('india','eu','us','global')),
  ADD COLUMN IF NOT EXISTS offboarding_status TEXT NOT NULL DEFAULT 'active'
    CHECK (offboarding_status IN ('active','offboarding_initiated','data_exported','deleted')),
  ADD COLUMN IF NOT EXISTS offboarding_initiated_at TIMESTAMPTZ;
