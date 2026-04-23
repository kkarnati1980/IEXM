CREATE TABLE IF NOT EXISTS lead_scores (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  scored_by_user_id TEXT REFERENCES users(id),
  previous_score TEXT CHECK (previous_score IN ('hot','warm','cold')),
  score TEXT NOT NULL CHECK (score IN ('hot','warm','cold')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_scores_interaction_created
ON lead_scores (tenant_id, interaction_id, created_at DESC);

GRANT SELECT, INSERT ON lead_scores TO app_runtime;

ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scores FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_scores_tenant_isolation ON lead_scores;
CREATE POLICY lead_scores_tenant_isolation ON lead_scores
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
