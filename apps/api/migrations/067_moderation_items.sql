-- 067: moderation_items — JSONB payload pattern per CR-VENDOR §15.1
-- Each proposed change to vendor_profiles or stall_branding is a row here.
-- The entity shell table's currently_published_item_id points to the live approved row.
CREATE TABLE IF NOT EXISTS moderation_items (
  id               UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT             NOT NULL REFERENCES tenants(id),
  entity_type      TEXT             NOT NULL
                   CHECK (entity_type IN ('vendor_profiles', 'stall_branding')),
  entity_id        UUID             NOT NULL,
  state            moderation_status NOT NULL DEFAULT 'draft',
  payload          JSONB            NOT NULL DEFAULT '{}'::jsonb,
  editor_user_id   TEXT             NOT NULL REFERENCES users(id),
  approver_user_id TEXT             REFERENCES users(id),
  submitted_at     TIMESTAMPTZ,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- Add deferred FK from shell tables to moderation_items now that the table exists
ALTER TABLE vendor_profiles
  ADD CONSTRAINT vendor_profiles_published_item_fk
  FOREIGN KEY (currently_published_item_id) REFERENCES moderation_items(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE stall_branding
  ADD CONSTRAINT stall_branding_published_item_fk
  FOREIGN KEY (currently_published_item_id) REFERENCES moderation_items(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE moderation_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY moderation_items_rls ON moderation_items
  USING  (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE INDEX idx_modi_entity       ON moderation_items(entity_type, entity_id);
CREATE INDEX idx_modi_tenant_state ON moderation_items(tenant_id, state);
CREATE INDEX idx_modi_editor       ON moderation_items(editor_user_id);

GRANT SELECT, INSERT, UPDATE ON moderation_items TO app_runtime;

INSERT INTO schema_migrations (version)
  VALUES ('067_moderation_items') ON CONFLICT DO NOTHING;
