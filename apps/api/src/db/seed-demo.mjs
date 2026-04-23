import { createSeedState } from "../store.mjs";

export async function seedDemoData(db) {
  const seed = createSeedState();
  const now = new Date().toISOString();

  await db.withTransaction(async (tx) => {
    for (const tenant of seed.tenants) {
      await tx.query(
        `INSERT INTO tenants (id, slug, name, created_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [tenant.id, tenant.slug, tenant.name, tenant.created_at]
      );
    }

    for (const organization of seed.organizations) {
      await tx.query(
        `INSERT INTO organizations (id, tenant_id, type, name, created_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (id) DO NOTHING`,
        [organization.id, organization.tenant_id, organization.type, organization.name]
      );
    }

    for (const user of seed.users) {
      await tx.query(
        `INSERT INTO users (
          id, tenant_id, organization_id, email, display_name, role,
          external_identity_provider, external_subject, status, last_login_at,
          disabled_at, disabled_reason, mfa_required, invited_at, deleted_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
         ON CONFLICT (id) DO NOTHING`,
        [
          user.id,
          user.tenant_id,
          user.organization_id,
          user.email,
          user.display_name,
          user.role,
          user.external_identity_provider ?? null,
          user.external_subject ?? null,
          user.status ?? "active",
          user.last_login_at ?? null,
          user.disabled_at ?? null,
          user.disabled_reason ?? null,
          user.mfa_required ?? false,
          user.invited_at ?? null,
          user.deleted_at ?? null
        ]
      );
    }

    for (const event of seed.events) {
      await tx.query(
        `INSERT INTO events (
          id, tenant_id, organizer_organization_id, name, status,
          metrics_definition_version, report_snapshot_version, starts_at, ends_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO NOTHING`,
        [
          event.id,
          event.tenant_id,
          event.organizer_organization_id,
          event.name,
          event.status,
          event.metrics_definition_version,
          event.report_snapshot_version,
          event.starts_at,
          event.ends_at,
          event.created_at ?? now
        ]
      );
    }

    for (const hall of seed.halls) {
      await tx.query(
        `INSERT INTO halls (id, tenant_id, event_id, name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [hall.id, hall.tenant_id, hall.event_id, hall.name]
      );
    }

    for (const stall of seed.stalls) {
      await tx.query(
        `INSERT INTO stalls (
          id, tenant_id, event_id, hall_id, vendor_organization_id, sponsor_organization_id, code, name
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO NOTHING`,
        [
          stall.id,
          stall.tenant_id,
          stall.event_id,
          stall.hall_id,
          stall.vendor_organization_id,
          stall.sponsor_organization_id,
          stall.code,
          stall.name
        ]
      );
    }

    for (const policy of seed.eventPolicies) {
      await tx.query(
        `INSERT INTO event_data_policies (
          event_id, tenant_id, vendor_exports_enabled, sponsor_pii_enabled, require_export_approval,
          allow_crm_push, retention_days, allow_cross_event_identity_graph, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (event_id) DO NOTHING`,
        [
          policy.event_id,
          policy.tenant_id,
          policy.vendor_exports_enabled,
          policy.sponsor_pii_enabled,
          policy.require_export_approval,
          policy.allow_crm_push,
          policy.retention_days,
          policy.allow_cross_event_identity_graph,
          policy.created_at,
          policy.updated_at
        ]
      );
    }

    for (const device of seed.devices) {
      await tx.query(
        `INSERT INTO devices (id, tenant_id, serial_number, status, config_lease_expires_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [device.id, device.tenant_id, device.serial_number, device.status, device.config_lease_expires_at]
      );
    }

    for (const assignment of seed.deviceAssignments) {
      await tx.query(
        `INSERT INTO device_assignments (
          id, tenant_id, device_id, event_id, stall_id, active, assignment_checksum
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING`,
        [
          assignment.id,
          assignment.tenant_id,
          assignment.device_id,
          assignment.event_id,
          assignment.stall_id,
          assignment.active,
          assignment.assignment_checksum
        ]
      );
    }

    for (const scope of seed.userAccessScopes ?? []) {
      await tx.query(
        `INSERT INTO user_access_scopes (
          id, tenant_id, user_id, event_id, stall_id, sponsor_organization_id, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO NOTHING`,
        [
          scope.id,
          scope.tenant_id,
          scope.user_id,
          scope.event_id,
          scope.stall_id,
          scope.sponsor_organization_id,
          scope.created_at
        ]
      );
    }

    for (const credential of seed.deviceCredentials ?? []) {
      await tx.query(
        `INSERT INTO device_credentials (
          id, tenant_id, device_id, credential_label, token_hash, status,
          created_by_user_id, revoked_by_user_id, last_used_at, revoked_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO NOTHING`,
        [
          credential.id,
          credential.tenant_id,
          credential.device_id,
          credential.credential_label,
          credential.token_hash,
          credential.status,
          credential.created_by_user_id,
          credential.revoked_by_user_id,
          credential.last_used_at,
          credential.revoked_at,
          credential.created_at
        ]
      );
    }
  });
}
