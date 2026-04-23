CREATE TABLE IF NOT EXISTS commercial_partners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('referrer','channel_partner','delivery_ecosystem_partner')),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  access_level TEXT NOT NULL CHECK (access_level IN ('commercial_status_only','platform_access_provisioned')),
  platform_user_id TEXT REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (access_level <> 'platform_access_provisioned' OR platform_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_commercial_partners_tenant_type
ON commercial_partners (tenant_id, partner_type);

CREATE TABLE IF NOT EXISTS commercial_deals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  partner_id TEXT REFERENCES commercial_partners(id),
  account_name TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'lead_added','contacted','replied','call_scheduled','demo_done',
    'proposal_sent','negotiation','closed_won','closed_lost'
  )),
  next_action TEXT NOT NULL,
  next_action_at TIMESTAMPTZ NOT NULL,
  offer_structure TEXT NOT NULL CHECK (offer_structure IN ('organizer_paid','sponsor_funded','mixed')),
  commercial_positioning_ack BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commercial_deals_tenant_stage
ON commercial_deals (tenant_id, stage);

CREATE TABLE IF NOT EXISTS commercial_partner_payouts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  partner_id TEXT NOT NULL REFERENCES commercial_partners(id),
  deal_id TEXT REFERENCES commercial_deals(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','paid','cancelled')),
  client_payment_received_at TIMESTAMPTZ,
  approved_by_user_id TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (status <> 'approved' OR approved_at IS NOT NULL),
  CHECK (status <> 'paid' OR (approved_at IS NOT NULL AND client_payment_received_at IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_commercial_partner_payouts_tenant_status
ON commercial_partner_payouts (tenant_id, status);

CREATE TABLE IF NOT EXISTS commercial_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  approval_type TEXT NOT NULL CHECK (approval_type IN (
    'standard_proposal','pricing_discount','pricing_exception','partner_payout_exception'
  )),
  subject_id TEXT,
  requested_by_user_id TEXT REFERENCES users(id),
  approver_user_id TEXT REFERENCES users(id),
  approver_role TEXT NOT NULL CHECK (approver_role IN ('account_owner','founder','product_owner','platform_admin')),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  CHECK (approval_status = 'pending' OR decided_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_commercial_approvals_tenant_type
ON commercial_approvals (tenant_id, approval_type);

CREATE TABLE IF NOT EXISTS commercial_partner_status_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  partner_id TEXT NOT NULL REFERENCES commercial_partners(id),
  deal_id TEXT REFERENCES commercial_deals(id),
  update_type TEXT NOT NULL CHECK (update_type IN ('commercial_status','deal_status','payout_status')),
  summary TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commercial_partner_status_updates_partner
ON commercial_partner_status_updates (tenant_id, partner_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON commercial_partners TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON commercial_deals TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON commercial_partner_payouts TO app_runtime;
GRANT SELECT, INSERT ON commercial_approvals TO app_runtime;
GRANT SELECT, INSERT ON commercial_partner_status_updates TO app_runtime;

ALTER TABLE commercial_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_partners FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_deals FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_partner_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_partner_payouts FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE commercial_partner_status_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_partner_status_updates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commercial_partners_tenant_isolation ON commercial_partners;
CREATE POLICY commercial_partners_tenant_isolation ON commercial_partners
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

DROP POLICY IF EXISTS commercial_deals_tenant_isolation ON commercial_deals;
CREATE POLICY commercial_deals_tenant_isolation ON commercial_deals
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

DROP POLICY IF EXISTS commercial_partner_payouts_tenant_isolation ON commercial_partner_payouts;
CREATE POLICY commercial_partner_payouts_tenant_isolation ON commercial_partner_payouts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

DROP POLICY IF EXISTS commercial_approvals_tenant_isolation ON commercial_approvals;
CREATE POLICY commercial_approvals_tenant_isolation ON commercial_approvals
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

DROP POLICY IF EXISTS commercial_partner_status_updates_tenant_isolation ON commercial_partner_status_updates;
CREATE POLICY commercial_partner_status_updates_tenant_isolation ON commercial_partner_status_updates
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
