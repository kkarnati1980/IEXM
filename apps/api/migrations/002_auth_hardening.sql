ALTER TABLE users
  ADD COLUMN IF NOT EXISTS external_identity_provider TEXT,
  ADD COLUMN IF NOT EXISTS external_subject TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_external_identity_unique
ON users (external_identity_provider, external_subject)
WHERE external_identity_provider IS NOT NULL AND external_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_access_scopes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT REFERENCES events(id),
  stall_id TEXT REFERENCES stalls(id),
  sponsor_organization_id TEXT REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_access_scopes_tenant_user
ON user_access_scopes (tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  credential_label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_by_user_id TEXT REFERENCES users(id),
  revoked_by_user_id TEXT REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_credentials_tenant_device
ON device_credentials (tenant_id, device_id, created_at DESC);
