-- 068: moderation_notes — immutable audit trail for moderation transitions (AP-5)
-- Risk 2 fix: tenant_id column + proper RLS (not USING(true)).
-- action enum expanded to cover all transition types from §14.1.
CREATE TABLE IF NOT EXISTS moderation_notes (
  id             UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT             NOT NULL REFERENCES tenants(id),
  target_table   TEXT             NOT NULL
                 CHECK (target_table IN ('vendor_profiles', 'stall_branding')),
  target_id      UUID             NOT NULL,
  actor_user_id  TEXT             NOT NULL REFERENCES users(id),
  action         TEXT             NOT NULL
                 CHECK (action IN (
                   'submit', 'claim', 'approve', 'reject',
                   'request_changes', 'withdraw', 'discard', 'supersede'
                 )),
  note           TEXT             NOT NULL,
  prior_status   moderation_status,
  new_status     moderation_status NOT NULL,
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- AP-5: immutability — no UPDATE or DELETE ever
CREATE OR REPLACE FUNCTION moderation_notes_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'moderation_notes rows are immutable — UPDATE and DELETE are prohibited (AP-5)';
END;
$$;

CREATE TRIGGER moderation_notes_no_update
  BEFORE UPDATE ON moderation_notes
  FOR EACH ROW EXECUTE FUNCTION moderation_notes_immutable();

CREATE TRIGGER moderation_notes_no_delete
  BEFORE DELETE ON moderation_notes
  FOR EACH ROW EXECUTE FUNCTION moderation_notes_immutable();

ALTER TABLE moderation_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY moderation_notes_rls ON moderation_notes
  USING  (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE INDEX idx_modnotes_target  ON moderation_notes(target_table, target_id);
CREATE INDEX idx_modnotes_tenant  ON moderation_notes(tenant_id);
CREATE INDEX idx_modnotes_actor   ON moderation_notes(actor_user_id);
CREATE INDEX idx_modnotes_created ON moderation_notes(created_at);

-- SELECT + INSERT only — no UPDATE, no DELETE for app_runtime (reinforces trigger)
GRANT SELECT, INSERT ON moderation_notes TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('068_moderation_notes') ON CONFLICT DO NOTHING;
