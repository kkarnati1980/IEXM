import { HttpError } from "../http-error.mjs";
import { rowOrThrow } from "../db/postgres.mjs";

export function createPostgresRepositories(db, securityContext = null) {
  function defaultEventPolicy(tenantId, eventId) {
    return {
      event_id: eventId,
      tenant_id: tenantId,
      vendor_exports_enabled: false,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: false,
      retention_days: 30,
      allow_cross_event_identity_graph: false,
      created_at: null,
      updated_at: null,
      missing_policy_row: true
    };
  }

  const execute = (text, params = []) => {
    if (securityContext?.tenantId && typeof db.queryWithContext === "function") {
      return db.queryWithContext(securityContext, text, params);
    }
    return db.query(text, params);
  };

  const repos = {
    backend: "postgres",
    scope(nextSecurityContext = {}) {
      return createPostgresRepositories(db, { ...securityContext, ...nextSecurityContext });
    },
    async withTransaction(callback) {
      return db.withTransaction(async (tx) => {
        if (securityContext?.tenantId && typeof tx.applySecurityContext === "function") {
          await tx.applySecurityContext(securityContext);
        }
        return callback(createPostgresRepositories(tx, securityContext));
      });
    },
    tenants: {
      async findById(tenantId) {
        return one(
          await execute("SELECT * FROM tenants WHERE id = $1", [tenantId]),
          "Tenant"
        );
      },
      async listAll() {
        return many(await execute("SELECT * FROM tenants ORDER BY created_at DESC", []));
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO tenants (id, slug, name, data_residency_zone, offboarding_status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [
              record.id,
              record.slug,
              record.name,
              record.data_residency_zone ?? "global",
              record.offboarding_status ?? "active",
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "Tenant"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE tenants SET slug=$2, name=$3, data_residency_zone=$4, offboarding_status=$5,
             offboarding_initiated_at=$6, last_compliance_check_at=$7, last_compliance_status=$8
             WHERE id=$1 RETURNING *`,
            [
              record.id,
              record.slug,
              record.name,
              record.data_residency_zone,
              record.offboarding_status,
              record.offboarding_initiated_at,
              record.last_compliance_check_at,
              record.last_compliance_status
            ]
          ),
          "Tenant"
        );
      },
      async findBySlug(slug) {
        const result = await execute("SELECT * FROM tenants WHERE slug = $1", [slug]);
        return result.rows[0] ?? null;
      }
    },
    organizations: {
      async findById(tenantId, id) {
        return one(
          await execute(
            "SELECT * FROM organizations WHERE tenant_id = $1 AND id = $2",
            [tenantId, id]
          ),
          "Organization"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            "SELECT * FROM organizations WHERE tenant_id = $1 ORDER BY created_at DESC",
            [tenantId]
          )
        );
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO organizations (id, tenant_id, type, name, status, created_at)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.type,
              record.name,
              record.status ?? "active",
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "Organization"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE organizations SET name=$2, type=$3, status=$4 WHERE id=$1 RETURNING *`,
            [record.id, record.name, record.type, record.status]
          ),
          "Organization"
        );
      }
    },
    users: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO users (
              id, tenant_id, organization_id, email, display_name, role,
              external_identity_provider, external_subject, status, last_login_at,
              disabled_at, disabled_reason, mfa_required, invited_at, deleted_at, created_at,
              invited_by_user_id, invitation_token_hash, invitation_expires_at,
              password_reset_token_hash, password_reset_expires_at, password_hash
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.organization_id,
              record.email,
              record.display_name,
              record.role,
              record.external_identity_provider,
              record.external_subject,
              record.status,
              record.last_login_at,
              record.disabled_at,
              record.disabled_reason,
              record.mfa_required,
              record.invited_at,
              record.deleted_at,
              record.created_at,
              record.invited_by_user_id ?? null,
              record.invitation_token_hash ?? null,
              record.invitation_expires_at ?? null,
              record.password_reset_token_hash ?? null,
              record.password_reset_expires_at ?? null,
              record.password_hash ?? null
            ]
          ),
          "User"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM users WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "User"
        );
      },
      async findByEmail(email) {
        const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
        return result.rows[0] ?? null;
      },
      async findByExternalSubject(issuer, subject) {
        const result = await db.query(
          `SELECT * FROM users
           WHERE external_identity_provider = $1 AND external_subject = $2`,
          [issuer, subject]
        );
        return result.rows[0] ?? null;
      },
      async listByTenant(tenantId) {
        return many(
          await execute("SELECT * FROM users WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId])
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE users
             SET organization_id = $2,
                 email = $3,
                 display_name = $4,
                 role = $5,
                 external_identity_provider = $6,
                 external_subject = $7,
                 status = $8,
                 last_login_at = $9,
                 disabled_at = $10,
                 disabled_reason = $11,
                 mfa_required = $12,
                 invited_at = $13,
                 deleted_at = $14,
                 invited_by_user_id = $15,
                 invitation_token_hash = $16,
                 invitation_expires_at = $17,
                 password_reset_token_hash = $18,
                 password_reset_expires_at = $19,
                 password_hash = $20
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.organization_id,
              record.email,
              record.display_name,
              record.role,
              record.external_identity_provider,
              record.external_subject,
              record.status,
              record.last_login_at,
              record.disabled_at,
              record.disabled_reason,
              record.mfa_required,
              record.invited_at,
              record.deleted_at,
              record.invited_by_user_id ?? null,
              record.invitation_token_hash ?? null,
              record.invitation_expires_at ?? null,
              record.password_reset_token_hash ?? null,
              record.password_reset_expires_at ?? null,
              record.password_hash ?? null
            ]
          ),
          "User"
        );
      },
      async findByInviteTokenHash(hash) {
        const result = await execute(
          `SELECT * FROM users WHERE invitation_token_hash = $1 AND invitation_expires_at > NOW()`,
          [hash]
        );
        return result.rows[0] ?? null;
      },
      async findByResetTokenHash(hash) {
        const result = await execute(
          `SELECT * FROM users WHERE password_reset_token_hash = $1 AND password_reset_expires_at > NOW()`,
          [hash]
        );
        return result.rows[0] ?? null;
      }
    },
    events: {
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM events WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Event"
        );
      },
      async listByTenant(tenantId) {
        return many(await execute("SELECT * FROM events WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]));
      },
      async listByIds(tenantId, ids) {
        if (!ids.length) return [];
        return many(await execute(
          "SELECT * FROM events WHERE tenant_id = $1 AND id = ANY($2::text[]) ORDER BY created_at DESC",
          [tenantId, ids]
        ));
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO events (id, tenant_id, organizer_organization_id, name, status,
             metrics_definition_version, report_snapshot_version, starts_at, ends_at,
             venue_name, city, country, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [
              record.id, record.tenant_id, record.organizer_organization_id,
              record.name, record.status ?? "draft",
              record.metrics_definition_version ?? 1,
              record.report_snapshot_version ?? 1,
              record.starts_at ?? null, record.ends_at ?? null,
              record.venue_name ?? null, record.city ?? null, record.country ?? null,
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "Event"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE events
             SET organizer_organization_id = $2,
                 name = $3,
                 status = $4,
                 metrics_definition_version = $5,
                 report_snapshot_version = $6,
                 starts_at = $7,
                 ends_at = $8
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.organizer_organization_id,
              record.name,
              record.status,
              record.metrics_definition_version,
              record.report_snapshot_version,
              record.starts_at,
              record.ends_at
            ]
          ),
          "Event"
        );
      }
    },
    halls: {
      async findById(tenantId, id) {
        return one(await execute("SELECT * FROM halls WHERE tenant_id = $1 AND id = $2", [tenantId, id]), "Hall");
      },
      async listByEvent(tenantId, eventId) {
        return many(await execute(
          "SELECT * FROM halls WHERE tenant_id = $1 AND event_id = $2 ORDER BY name ASC",
          [tenantId, eventId]
        ));
      },
      async create(record) {
        return one(
          await execute(
            "INSERT INTO halls (id, tenant_id, event_id, name) VALUES ($1,$2,$3,$4) RETURNING *",
            [record.id, record.tenant_id, record.event_id, record.name]
          ),
          "Hall"
        );
      },
      async update(record) {
        return one(
          await execute("UPDATE halls SET name=$2 WHERE id=$1 RETURNING *", [record.id, record.name]),
          "Hall"
        );
      },
      async deleteById(tenantId, id) {
        return one(
          await execute("DELETE FROM halls WHERE tenant_id=$1 AND id=$2 RETURNING *", [tenantId, id]),
          "Hall"
        );
      }
    },
    stalls: {
      async findById(tenantId, id) {
        return one(await execute("SELECT * FROM stalls WHERE tenant_id = $1 AND id = $2", [tenantId, id]), "Stall");
      },
      async listByTenant(tenantId) {
        return many(await execute(
          "SELECT * FROM stalls WHERE tenant_id = $1 ORDER BY event_id ASC, code ASC", [tenantId]
        ));
      },
      async listByEvent(tenantId, eventId) {
        return many(await execute(
          "SELECT * FROM stalls WHERE tenant_id = $1 AND event_id = $2 ORDER BY code ASC", [tenantId, eventId]
        ));
      },
      async listByHall(tenantId, hallId) {
        return many(await execute(
          "SELECT * FROM stalls WHERE tenant_id = $1 AND hall_id = $2 ORDER BY code ASC", [tenantId, hallId]
        ));
      },
      async findByStallCode(tenantId, eventId, code) {
        const result = await execute(
          "SELECT * FROM stalls WHERE tenant_id = $1 AND event_id = $2 AND code = $3", [tenantId, eventId, code]
        );
        return result.rows[0] ?? null;
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO stalls (id, tenant_id, event_id, hall_id, vendor_organization_id,
             sponsor_organization_id, code, name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              record.id, record.tenant_id, record.event_id, record.hall_id ?? null,
              record.vendor_organization_id ?? null, record.sponsor_organization_id ?? null,
              record.code, record.name
            ]
          ),
          "Stall"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE stalls SET hall_id=$2, vendor_organization_id=$3, sponsor_organization_id=$4,
             code=$5, name=$6 WHERE id=$1 RETURNING *`,
            [
              record.id, record.hall_id ?? null, record.vendor_organization_id ?? null,
              record.sponsor_organization_id ?? null, record.code, record.name
            ]
          ),
          "Stall"
        );
      },
      async deleteById(tenantId, id) {
        return one(
          await execute("DELETE FROM stalls WHERE tenant_id=$1 AND id=$2 RETURNING *", [tenantId, id]),
          "Stall"
        );
      }
    },
    eventPolicies: {
      async findByEventId(tenantId, eventId) {
        const result = await execute(
          "SELECT * FROM event_data_policies WHERE tenant_id = $1 AND event_id = $2",
          [tenantId, eventId]
        );
        return result.rows[0] ?? defaultEventPolicy(tenantId, eventId);
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO event_data_policies (
              event_id,
              tenant_id,
              vendor_exports_enabled,
              sponsor_pii_enabled,
              require_export_approval,
              allow_crm_push,
              retention_days,
              allow_cross_event_identity_graph,
              created_at,
              updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (event_id) DO UPDATE
            SET vendor_exports_enabled = EXCLUDED.vendor_exports_enabled,
                sponsor_pii_enabled = EXCLUDED.sponsor_pii_enabled,
                require_export_approval = EXCLUDED.require_export_approval,
                allow_crm_push = EXCLUDED.allow_crm_push,
                retention_days = EXCLUDED.retention_days,
                allow_cross_event_identity_graph = EXCLUDED.allow_cross_event_identity_graph,
                updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.event_id,
              record.tenant_id,
              record.vendor_exports_enabled,
              record.sponsor_pii_enabled,
              record.require_export_approval,
              record.allow_crm_push,
              record.retention_days,
              record.allow_cross_event_identity_graph,
              record.created_at,
              record.updated_at
            ]
          ),
          "Event policy"
        );
      }
    },
    devices: {
      async findById(tenantId, id) {
        return one(await execute("SELECT * FROM devices WHERE tenant_id = $1 AND id = $2", [tenantId, id]), "Device");
      },
      async listByTenant(tenantId) {
        return many(await execute("SELECT * FROM devices WHERE tenant_id = $1 ORDER BY id ASC", [tenantId]));
      },
      async listByEvent(tenantId, eventId) {
        return many(await execute(
          `SELECT d.* FROM devices d
           JOIN device_assignments da ON da.device_id = d.id AND da.active = TRUE
           WHERE d.tenant_id = $1 AND da.event_id = $2`,
          [tenantId, eventId]
        ));
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO devices (id, tenant_id, serial_number, status, config_lease_expires_at)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [
              record.id, record.tenant_id, record.serial_number,
              record.status ?? "inventory", record.config_lease_expires_at ?? null
            ]
          ),
          "Device"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE devices SET serial_number=$2, status=$3, config_lease_expires_at=$4
             WHERE id=$1 RETURNING *`,
            [record.id, record.serial_number, record.status, record.config_lease_expires_at ?? null]
          ),
          "Device"
        );
      }
    },
    userAccessScopes: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO user_access_scopes (
              id, tenant_id, user_id, event_id, stall_id, sponsor_organization_id, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.user_id,
              record.event_id,
              record.stall_id,
              record.sponsor_organization_id,
              record.created_at
            ]
          ),
          "User access scope"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            "SELECT * FROM user_access_scopes WHERE tenant_id = $1 AND id = $2",
            [tenantId, id]
          ),
          "User access scope"
        );
      },
      async listByUser(tenantId, userId) {
        return many(
          await execute(
            `SELECT * FROM user_access_scopes
             WHERE tenant_id = $1 AND user_id = $2
             ORDER BY created_at ASC`,
            [tenantId, userId]
          )
        );
      },
      async deleteById(tenantId, id) {
        return one(
          await execute(
            `DELETE FROM user_access_scopes
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [tenantId, id]
          ),
          "User access scope"
        );
      }
    },
    deviceCredentials: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO device_credentials (
              id, tenant_id, device_id, credential_label, token_hash, status,
              created_by_user_id, revoked_by_user_id, last_used_at, revoked_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.device_id,
              record.credential_label,
              record.token_hash,
              record.status,
              record.created_by_user_id,
              record.revoked_by_user_id,
              record.last_used_at,
              record.revoked_at,
              record.created_at
            ]
          ),
          "Device credential"
        );
      },
      async listByDevice(tenantId, deviceId) {
        return many(
          await execute(
            `SELECT * FROM device_credentials
             WHERE tenant_id = $1 AND device_id = $2
             ORDER BY created_at DESC`,
            [tenantId, deviceId]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            "SELECT * FROM device_credentials WHERE tenant_id = $1 AND id = $2",
            [tenantId, id]
          ),
          "Device credential"
        );
      },
      async findActiveByTokenHash(tokenHash) {
        const result = await db.query(
          `SELECT dc.*, d.id AS resolved_device_id, d.tenant_id AS resolved_tenant_id, d.status AS resolved_device_status
           FROM device_credentials dc
           JOIN devices d ON d.id = dc.device_id
           WHERE dc.token_hash = $1
             AND dc.status = 'active'
             AND dc.revoked_at IS NULL
           LIMIT 1`,
          [tokenHash]
        );
        return result.rows[0] ?? null;
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE device_credentials
             SET credential_label = $2,
                 status = $3,
                 revoked_by_user_id = $4,
                 last_used_at = $5,
                 revoked_at = $6
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.credential_label,
              record.status,
              record.revoked_by_user_id,
              record.last_used_at,
              record.revoked_at
            ]
          ),
          "Device credential"
        );
      }
    },
    deviceAssignments: {
      async findActiveByDeviceId(tenantId, deviceId) {
        return one(
          await execute(
            "SELECT * FROM device_assignments WHERE tenant_id = $1 AND device_id = $2 AND active = TRUE",
            [tenantId, deviceId]
          ),
          "Device assignment"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(await execute(
          "SELECT * FROM device_assignments WHERE tenant_id = $1 AND event_id = $2 AND active = TRUE ORDER BY device_id ASC",
          [tenantId, eventId]
        ));
      },
      async listByStall(tenantId, stallId) {
        return many(await execute(
          "SELECT * FROM device_assignments WHERE tenant_id = $1 AND stall_id = $2 AND active = TRUE",
          [tenantId, stallId]
        ));
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM device_assignments WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Device assignment"
        );
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO device_assignments (id, tenant_id, device_id, event_id, stall_id, active, assignment_checksum)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [
              record.id, record.tenant_id, record.device_id, record.event_id, record.stall_id,
              record.active ?? true, record.assignment_checksum ?? ""
            ]
          ),
          "Device assignment"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE device_assignments SET event_id=$2, stall_id=$3, active=$4, assignment_checksum=$5
             WHERE id=$1 RETURNING *`,
            [record.id, record.event_id, record.stall_id, record.active, record.assignment_checksum ?? ""]
          ),
          "Device assignment"
        );
      }
    },
    heartbeats: {
      async findBySourceCursor(sourceCursor) {
        const result = await execute(
          "SELECT * FROM device_heartbeats WHERE source_cursor = $1",
          [sourceCursor]
        );
        return result.rows[0] ?? null;
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO device_heartbeats (
              id, tenant_id, device_id, event_id, stall_id, battery_level, local_queue_depth,
              assignment_checksum, connectivity_status, reader_status, app_version, firmware_version,
              source_cursor, raw_payload, recorded_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.device_id,
              record.event_id,
              record.stall_id,
              record.battery_level,
              record.local_queue_depth,
              record.assignment_checksum ?? null,
              record.connectivity_status ?? "online",
              record.reader_status ?? "connected",
              record.app_version ?? null,
              record.firmware_version ?? null,
              record.source_cursor ?? null,
              JSON.stringify(record.raw_payload ?? {}),
              record.recorded_at
            ]
          ),
          "Heartbeat"
        );
      },
      async listByDevice(tenantId, deviceId) {
        return many(
          await execute(
            "SELECT * FROM device_heartbeats WHERE tenant_id = $1 AND device_id = $2 ORDER BY recorded_at DESC",
            [tenantId, deviceId]
          )
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            "SELECT * FROM device_heartbeats WHERE tenant_id = $1 AND event_id = $2 ORDER BY recorded_at DESC",
            [tenantId, eventId]
          )
        );
      }
    },
    incidents: {
      async findBySourceCursor(sourceCursor) {
        const result = await execute(
          "SELECT * FROM device_incidents WHERE source_cursor = $1",
          [sourceCursor]
        );
        return result.rows[0] ?? null;
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO device_incidents (
              id, tenant_id, device_id, event_id, stall_id, severity, code, message, status,
              assignment_checksum, metadata, occurred_at, resolved_at, source_cursor, raw_payload, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.device_id,
              record.event_id ?? null,
              record.stall_id ?? null,
              record.severity,
              record.code,
              record.message ?? null,
              record.status,
              record.assignment_checksum ?? null,
              JSON.stringify(record.metadata ?? {}),
              record.occurred_at ?? record.created_at,
              record.resolved_at ?? null,
              record.source_cursor ?? null,
              JSON.stringify(record.raw_payload ?? {}),
              record.created_at,
            ]
          ),
          "Incident"
        );
      },
      async listByDevice(tenantId, deviceId) {
        return many(
          await execute(
            "SELECT * FROM device_incidents WHERE tenant_id = $1 AND device_id = $2 ORDER BY occurred_at DESC NULLS LAST, created_at DESC",
            [tenantId, deviceId]
          )
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            "SELECT * FROM device_incidents WHERE tenant_id = $1 AND event_id = $2 ORDER BY occurred_at DESC NULLS LAST, created_at DESC",
            [tenantId, eventId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE device_incidents
             SET severity = $2,
                 code = $3,
                 message = $4,
                 status = $5,
                 assignment_checksum = $6,
                 metadata = $7::jsonb,
                 occurred_at = $8,
                 resolved_at = $9
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.severity,
              record.code,
              record.message ?? null,
              record.status,
              record.assignment_checksum ?? null,
              JSON.stringify(record.metadata ?? {}),
              record.occurred_at ?? record.created_at,
              record.resolved_at ?? null
            ]
          ),
          "Incident"
        );
      }
    },
    attendees: {
      async create(record) {
        return one(
          await execute(
            "INSERT INTO attendees (id, tenant_id, created_at) VALUES ($1,$2,$3) RETURNING *",
            [record.id, record.tenant_id, record.created_at]
          ),
          "Attendee"
        );
      },
      async findById(tenantId, id) {
        return one(await execute("SELECT * FROM attendees WHERE tenant_id = $1 AND id = $2", [tenantId, id]), "Attendee");
      },
      async listByTenant(tenantId) {
        return many(await execute("SELECT * FROM attendees WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]));
      },
      async update(record) {
        return one(
          await execute("UPDATE attendees SET tenant_id=$2 WHERE id=$1 RETURNING *", [record.id, record.tenant_id]),
          "Attendee"
        );
      }
    },
    attendeeProfiles: {
      async findByAttendeeId(attendeeId) {
        const result = await execute("SELECT * FROM attendee_profiles WHERE attendee_id = $1", [attendeeId]);
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO attendee_profiles (
              attendee_id, full_name, company_name, email, phone, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (attendee_id)
            DO UPDATE SET
              full_name = EXCLUDED.full_name,
              company_name = EXCLUDED.company_name,
              email = EXCLUDED.email,
              phone = EXCLUDED.phone,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.attendee_id,
              record.full_name,
              record.company_name,
              record.email,
              record.phone,
              record.updated_at
            ]
          ),
          "Attendee profile"
        );
      }
    },
    tapEvents: {
      async findByIdempotencyKey(tenantId, deviceId, localEventId) {
        const result = await execute(
          "SELECT * FROM tap_events WHERE tenant_id = $1 AND device_id = $2 AND local_event_id = $3",
          [tenantId, deviceId, localEventId]
        );
        return result.rows[0] ?? null;
      },
      async create(record) {
        try {
          return one(
            await execute(
              `INSERT INTO tap_events (
                id, tenant_id, event_id, stall_id, device_id, local_event_id, tap_type,
                reader_uid_hash, ndef_payload, occurred_at, created_at, cloud_received_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
              RETURNING *`,
              [
                record.id,
                record.tenant_id,
                record.event_id,
                record.stall_id,
                record.device_id,
                record.local_event_id,
                record.tap_type,
                record.reader_uid_hash,
                record.ndef_payload,
                record.occurred_at,
                record.created_at,
                record.cloud_received_at
              ]
            ),
            "Tap event"
          );
        } catch (error) {
          if (error.code === "23505") {
            throw new HttpError(409, "Duplicate tap event", { code: "duplicate_tap" });
          }
          throw error;
        }
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            "SELECT * FROM tap_events WHERE tenant_id = $1 AND event_id = $2 ORDER BY created_at DESC",
            [tenantId, eventId]
          )
        );
      }
    },
    interactions: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO interactions (
              id, tenant_id, event_id, stall_id, tap_event_id, attendee_id, captured_by_user_id,
              status, consent_status, classification, sponsor_click_count, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.stall_id,
              record.tap_event_id,
              record.attendee_id,
              record.captured_by_user_id,
              record.status,
              record.consent_status,
              record.classification ?? "cold",
              record.sponsor_click_count ?? 0,
              record.created_at,
              record.updated_at ?? record.created_at
            ]
          ),
          "Interaction"
        );
      },
      async findById(tenantId, id) {
        return one(await execute("SELECT * FROM interactions WHERE tenant_id = $1 AND id = $2", [tenantId, id]), "Interaction");
      },
      async findByTapEventId(tenantId, tapEventId) {
        const result = await execute(
          "SELECT * FROM interactions WHERE tenant_id = $1 AND tap_event_id = $2",
          [tenantId, tapEventId]
        );
        return result.rows[0] ?? null;
      },
      async listByStall(tenantId, stallId) {
        return many(
          await execute(
            "SELECT * FROM interactions WHERE tenant_id = $1 AND stall_id = $2 ORDER BY created_at DESC",
            [tenantId, stallId]
          )
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            "SELECT * FROM interactions WHERE tenant_id = $1 AND event_id = $2 ORDER BY created_at DESC",
            [tenantId, eventId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE interactions
             SET attendee_id = $2,
                 captured_by_user_id = $3,
                 status = $4,
                 consent_status = $5,
                 classification = $6,
                 sponsor_click_count = $7,
                 updated_at = $8
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.attendee_id,
              record.captured_by_user_id,
              record.status,
              record.consent_status,
              record.classification ?? "cold",
              record.sponsor_click_count ?? 0,
              record.updated_at ?? new Date().toISOString()
            ]
          ),
          "Interaction"
        );
      }
    },
    consents: {
      async findByInteractionId(tenantId, interactionId) {
        const result = await execute(
          "SELECT * FROM consents WHERE tenant_id = $1 AND interaction_id = $2",
          [tenantId, interactionId]
        );
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO consents (
              interaction_id, tenant_id, attendee_id, vendor_release_allowed, sponsor_release_allowed,
              revoked_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (interaction_id)
            DO UPDATE SET
              attendee_id = EXCLUDED.attendee_id,
              vendor_release_allowed = EXCLUDED.vendor_release_allowed,
              sponsor_release_allowed = EXCLUDED.sponsor_release_allowed,
              revoked_at = EXCLUDED.revoked_at,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.interaction_id,
              record.tenant_id,
              record.attendee_id,
              record.vendor_release_allowed,
              record.sponsor_release_allowed,
              record.revoked_at,
              record.updated_at
            ]
          ),
          "Consent"
        );
      }
    },
    consentEvents: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO consent_events (
              id, interaction_id, tenant_id, action, vendor_release_allowed, sponsor_release_allowed,
              locale, ip_address, user_agent, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING *`,
            [
              record.id,
              record.interaction_id,
              record.tenant_id,
              record.action,
              record.vendor_release_allowed,
              record.sponsor_release_allowed,
              record.locale,
              record.ip_address,
              record.user_agent,
              record.created_at
            ]
          ),
          "Consent event"
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM consent_events
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY created_at ASC`,
            [tenantId, interactionId]
          )
        );
      }
    },
    communicationChannelConsents: {
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO communication_channel_consents (
              id, tenant_id, interaction_id, attendee_id, channel, allowed, source,
              evidence, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (interaction_id, channel) DO UPDATE
              SET allowed = EXCLUDED.allowed,
                  source = EXCLUDED.source,
                  evidence = EXCLUDED.evidence,
                  updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.interaction_id,
              record.attendee_id,
              record.channel,
              record.allowed,
              record.source,
              JSON.stringify(record.evidence ?? {}),
              record.created_at,
              record.updated_at
            ]
          ),
          "Communication channel consent"
        );
      },
      async findByInteractionAndChannel(tenantId, interactionId, channel) {
        return maybeOne(
          await execute(
            `SELECT * FROM communication_channel_consents
             WHERE tenant_id = $1 AND interaction_id = $2 AND channel = $3`,
            [tenantId, interactionId, channel]
          )
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM communication_channel_consents
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY channel ASC`,
            [tenantId, interactionId]
          )
        );
      }
    },
    communicationSuppressions: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO communication_suppressions (
              id, tenant_id, event_id, interaction_id, attendee_id, channel,
              status, reason, source, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.interaction_id,
              record.attendee_id,
              record.channel,
              record.status,
              record.reason,
              record.source,
              record.created_at,
              record.updated_at
            ]
          ),
          "Communication suppression"
        );
      },
      async findActiveByInteractionAndChannel(tenantId, interactionId, channel) {
        return maybeOne(
          await execute(
            `SELECT * FROM communication_suppressions
             WHERE tenant_id = $1 AND interaction_id = $2 AND channel = $3 AND status = 'active'
             ORDER BY created_at DESC
             LIMIT 1`,
            [tenantId, interactionId, channel]
          )
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM communication_suppressions
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY created_at DESC`,
            [tenantId, interactionId]
          )
        );
      },
      async deactivateByInteractionAndChannel(tenantId, interactionId, channel, now) {
        return many(
          await execute(
            `UPDATE communication_suppressions
             SET status = 'inactive',
                 updated_at = $4
             WHERE tenant_id = $1 AND interaction_id = $2 AND channel = $3 AND status = 'active'
             RETURNING *`,
            [tenantId, interactionId, channel, now]
          )
        );
      }
    },
    interactionNotes: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO interaction_notes (
              id, interaction_id, tenant_id, author_user_id, note, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *`,
            [
              record.id,
              record.interaction_id,
              record.tenant_id,
              record.author_user_id,
              record.note,
              record.created_at
            ]
          ),
          "Interaction note"
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM interaction_notes
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY created_at ASC`,
            [tenantId, interactionId]
          )
        );
      }
    },
    shortLinks: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO short_links (
              id, tenant_id, token_hash, target_type, target_id, target_payload,
              status, expires_at, consumed_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.token_hash,
              record.target_type,
              record.target_id,
              record.target_payload ?? {},
              record.status,
              record.expires_at,
              record.consumed_at,
              record.created_at
            ]
          ),
          "Short link"
        );
      },
      async findByTokenHash(tokenHash) {
        return maybeOne(
          await execute(
            `SELECT * FROM short_links WHERE token_hash = $1`,
            [tokenHash]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM short_links WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "Short link"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            `SELECT * FROM short_links WHERE tenant_id = $1 ORDER BY created_at DESC`,
            [tenantId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE short_links
             SET status = $2,
                 expires_at = $3,
                 consumed_at = $4
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.status,
              record.expires_at,
              record.consumed_at
            ]
          ),
          "Short link"
        );
      }
    },
    walletPasses: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO wallet_passes (
              id, tenant_id, event_id, stall_id, interaction_id, pass_type,
              status, artifact_ref, short_link_id, failure_code, failure_message,
              requested_by_user_id, delivered_at, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.stall_id,
              record.interaction_id,
              record.pass_type,
              record.status,
              record.artifact_ref,
              record.short_link_id,
              record.failure_code,
              record.failure_message,
              record.requested_by_user_id,
              record.delivered_at,
              record.created_at,
              record.updated_at
            ]
          ),
          "Wallet pass"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM wallet_passes WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "Wallet pass"
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM wallet_passes
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY created_at DESC`,
            [tenantId, interactionId]
          )
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM wallet_passes
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE wallet_passes
             SET status = $3,
                 pass_type = $4,
                 artifact_ref = $5,
                 short_link_id = $6,
                 failure_code = $7,
                 failure_message = $8,
                 requested_by_user_id = $9,
                 delivered_at = $10,
                 updated_at = $11
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.status,
              record.pass_type,
              record.artifact_ref,
              record.short_link_id,
              record.failure_code,
              record.failure_message,
              record.requested_by_user_id,
              record.delivered_at,
              record.updated_at
            ]
          ),
          "Wallet pass"
        );
      }
    },
    walletPassAttempts: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO wallet_pass_attempts (
              id, tenant_id, event_id, stall_id, interaction_id, wallet_pass_id,
              provider, status, reason, pass_type, artifact_ref, short_link_id,
              failure_code, failure_message, attempted_by_user_id, attempted_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.stall_id,
              record.interaction_id,
              record.wallet_pass_id,
              record.provider,
              record.status,
              record.reason,
              record.pass_type,
              record.artifact_ref,
              record.short_link_id,
              record.failure_code,
              record.failure_message,
              record.attempted_by_user_id,
              record.attempted_at
            ]
          ),
          "Wallet pass attempt"
        );
      },
      async listByWalletPass(tenantId, walletPassId) {
        return many(
          await execute(
            `SELECT * FROM wallet_pass_attempts
             WHERE tenant_id = $1 AND wallet_pass_id = $2
             ORDER BY attempted_at ASC`,
            [tenantId, walletPassId]
          )
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM wallet_pass_attempts
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY attempted_at DESC`,
            [tenantId, eventId]
          )
        );
      }
    },
    notifications: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO notifications (
              id, tenant_id, event_id, interaction_id, channel, message_type,
              status, provider, recipient_hash, consent_checked_at, sending_started_at,
              last_attempt_at, next_attempt_at, attempts_count, provider_message_id, final_error,
              retry_exhausted_at, retry_exhausted_reason, created_by_user_id, approved_by_user_id,
              created_at, updated_at, system_payload
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id ?? null,
              record.interaction_id,
              record.channel,
              record.message_type,
              record.status,
              record.provider ?? null,
              record.recipient_hash ?? null,
              record.consent_checked_at ?? null,
              record.sending_started_at ?? null,
              record.last_attempt_at ?? null,
              record.next_attempt_at ?? null,
              record.attempts_count ?? 0,
              record.provider_message_id ?? null,
              record.final_error ?? null,
              record.retry_exhausted_at ?? null,
              record.retry_exhausted_reason ?? null,
              record.created_by_user_id,
              record.approved_by_user_id,
              record.created_at,
              record.updated_at,
              record.system_payload ? JSON.stringify(record.system_payload) : null
            ]
          ),
          "Notification"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM notifications WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "Notification"
        );
      },
      async findByProviderMessageId(tenantId, providerMessageId) {
        const result = await execute(
          `SELECT * FROM notifications
           WHERE tenant_id = $1 AND provider_message_id = $2
           ORDER BY updated_at DESC
           LIMIT 1`,
          [tenantId, providerMessageId]
        );
        return result.rows[0] ?? null;
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM notifications
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY updated_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async listQueued(tenantId, options = {}) {
        const values = [tenantId, options.now ?? new Date().toISOString(), Number(options.limit ?? 20)];
        const conditions = [
          "tenant_id = $1",
          "status = 'queued'",
          "(next_attempt_at IS NULL OR next_attempt_at <= $2)"
        ];
        if (options.eventId) {
          values.splice(2, 0, options.eventId);
          conditions.push("event_id = $3");
        }
        const limitIndex = options.eventId ? 4 : 3;
        return many(
          await execute(
            `SELECT * FROM notifications
             WHERE ${conditions.join(" AND ")}
             ORDER BY COALESCE(next_attempt_at, created_at) ASC, created_at ASC
             LIMIT $${limitIndex}`,
            values
          )
        );
      },
      async countByStatus(tenantId, eventId) {
        const result = await execute(
          `SELECT status, COUNT(*)::int AS count
           FROM notifications
           WHERE tenant_id = $1 AND event_id = $2
           GROUP BY status`,
          [tenantId, eventId]
        );
        return result.rows.reduce((acc, row) => {
          acc[row.status] = Number(row.count ?? 0);
          return acc;
        }, {});
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE notifications
             SET interaction_id = $3,
                 channel = $4,
                 message_type = $5,
                 status = $6,
                 provider = $7,
                 recipient_hash = $8,
                 consent_checked_at = $9,
                 sending_started_at = $10,
                 last_attempt_at = $11,
                 next_attempt_at = $12,
                 attempts_count = $13,
                 provider_message_id = $14,
                 final_error = $15,
                 retry_exhausted_at = $16,
                 retry_exhausted_reason = $17,
                 created_by_user_id = $18,
                 approved_by_user_id = $19,
                 created_at = $20,
                 updated_at = $21,
                 system_payload = $22
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.interaction_id,
              record.channel,
              record.message_type,
              record.status,
              record.provider ?? null,
              record.recipient_hash ?? null,
              record.consent_checked_at ?? null,
              record.sending_started_at ?? null,
              record.last_attempt_at ?? null,
              record.next_attempt_at ?? null,
              record.attempts_count ?? 0,
              record.provider_message_id ?? null,
              record.final_error ?? null,
              record.retry_exhausted_at ?? null,
              record.retry_exhausted_reason ?? null,
              record.created_by_user_id ?? null,
              record.approved_by_user_id ?? null,
              record.created_at,
              record.updated_at,
              record.system_payload ? JSON.stringify(record.system_payload) : null
            ]
          ),
          "Notification"
        );
      }
    },
    notificationAttempts: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO notification_attempts (
              id, tenant_id, notification_id, provider, status,
              attempt_number, provider_message_id, http_status, duration_ms, response_excerpt,
              error_message, attempted_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.notification_id,
              record.provider,
              record.status,
              record.attempt_number ?? 1,
              record.provider_message_id,
              record.http_status ?? null,
              record.duration_ms ?? null,
              record.response_excerpt ?? null,
              record.error_message,
              record.attempted_at
            ]
          ),
          "Notification attempt"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT attempts.*, notifications.event_id, notifications.interaction_id, notifications.channel
             FROM notification_attempts attempts
             JOIN notifications ON notifications.id = attempts.notification_id
             WHERE attempts.tenant_id = $1 AND notifications.event_id = $2
             ORDER BY attempts.attempted_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async listByNotification(tenantId, notificationId) {
        return many(
          await execute(
            `SELECT * FROM notification_attempts
             WHERE tenant_id = $1 AND notification_id = $2
             ORDER BY attempted_at ASC`,
            [tenantId, notificationId]
          )
        );
      }
    },
    notificationReceipts: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO notification_receipts (
              id, tenant_id, notification_id, provider, channel, receipt_type,
              provider_message_id, provider_event_id, dedupe_key, summary, payload,
              occurred_at, received_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.notification_id,
              record.provider,
              record.channel,
              record.receipt_type,
              record.provider_message_id ?? null,
              record.provider_event_id ?? null,
              record.dedupe_key,
              record.summary ?? null,
              JSON.stringify(record.payload ?? {}),
              record.occurred_at ?? null,
              record.received_at
            ]
          ),
          "Notification receipt"
        );
      },
      async findByDedupeKey(tenantId, dedupeKey) {
        const result = await execute(
          `SELECT * FROM notification_receipts
           WHERE tenant_id = $1 AND dedupe_key = $2`,
          [tenantId, dedupeKey]
        );
        return result.rows[0] ?? null;
      },
      async listByNotification(tenantId, notificationId) {
        return many(
          await execute(
            `SELECT * FROM notification_receipts
             WHERE tenant_id = $1 AND notification_id = $2
             ORDER BY COALESCE(occurred_at, received_at) DESC, received_at DESC`,
            [tenantId, notificationId]
          )
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT receipts.*, notifications.event_id, notifications.interaction_id
             FROM notification_receipts receipts
             JOIN notifications ON notifications.id = receipts.notification_id
             WHERE receipts.tenant_id = $1 AND notifications.event_id = $2
             ORDER BY COALESCE(receipts.occurred_at, receipts.received_at) DESC, receipts.received_at DESC`,
            [tenantId, eventId]
          )
        );
      }
    },
    followupMessages: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO followup_messages (
              id, tenant_id, event_id, stall_id, interaction_id, channel, subject,
              body, status, created_by_user_id, approved_by_user_id, notification_id,
              created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.stall_id,
              record.interaction_id,
              record.channel,
              record.subject,
              record.body,
              record.status,
              record.created_by_user_id,
              record.approved_by_user_id,
              record.notification_id,
              record.created_at,
              record.updated_at
            ]
          ),
          "Follow-up message"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM followup_messages WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "Follow-up message"
        );
      },
      async findByNotificationId(tenantId, notificationId) {
        return maybeOne(
          await execute(
            `SELECT * FROM followup_messages WHERE tenant_id = $1 AND notification_id = $2`,
            [tenantId, notificationId]
          )
        );
      },
      async listByStall(tenantId, stallId) {
        return many(
          await execute(
            `SELECT * FROM followup_messages
             WHERE tenant_id = $1 AND stall_id = $2
             ORDER BY created_at DESC`,
            [tenantId, stallId]
          )
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM followup_messages
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY created_at DESC`,
            [tenantId, interactionId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE followup_messages
             SET status = $3,
                 approved_by_user_id = $4,
                 notification_id = $5,
                 updated_at = $6
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.status,
              record.approved_by_user_id,
              record.notification_id,
              record.updated_at
            ]
          ),
          "Follow-up message"
        );
      }
    },
    leadScores: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO lead_scores (
              id, tenant_id, interaction_id, scored_by_user_id, previous_score,
              score, reason, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.interaction_id,
              record.scored_by_user_id,
              record.previous_score,
              record.score,
              record.reason,
              record.created_at
            ]
          ),
          "Lead score"
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM lead_scores
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY created_at DESC`,
            [tenantId, interactionId]
          )
        );
      }
    },
    exportRequests: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO export_requests (
              id, tenant_id, event_id, requested_by_user_id, requested_for_organization_id, export_type,
              filters, row_count_estimate, status, approval_required, approved_by_user_id,
              approval_reason, rejection_reason, file_url, file_expires_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.requested_by_user_id,
              record.requested_for_organization_id,
              record.export_type,
              JSON.stringify(record.filters ?? {}),
              record.row_count_estimate,
              record.status,
              record.approval_required,
              record.approved_by_user_id,
              record.approval_reason,
              record.rejection_reason,
              record.file_url,
              record.file_expires_at,
              record.created_at
            ]
          ),
          "Export request"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM export_requests
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM export_requests WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Export request"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE export_requests
             SET row_count_estimate = $2,
                 status = $3,
                 approval_required = $4,
                 approved_by_user_id = $5,
                 approval_reason = $6,
                 rejection_reason = $7,
                 file_url = $8,
                 file_expires_at = $9
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.row_count_estimate,
              record.status,
              record.approval_required,
              record.approved_by_user_id,
              record.approval_reason,
              record.rejection_reason,
              record.file_url,
              record.file_expires_at
            ]
          ),
          "Export request"
        );
      }
    },
    breakGlassAccess: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO break_glass_access (
              id, tenant_id, requested_by_user_id, first_approved_by_user_id, second_approved_by_user_id,
              justification, access_scope, status, starts_at, expires_at, revoked_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.requested_by_user_id,
              record.first_approved_by_user_id,
              record.second_approved_by_user_id,
              record.justification,
              typeof record.access_scope === "string" ? record.access_scope : JSON.stringify(record.access_scope),
              record.status,
              record.starts_at,
              record.expires_at,
              record.revoked_at,
              record.created_at
            ]
          ),
          "Break-glass request"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            `SELECT * FROM break_glass_access
             WHERE tenant_id = $1
             ORDER BY created_at DESC`,
            [tenantId]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM break_glass_access WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Break-glass request"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE break_glass_access
             SET first_approved_by_user_id = $2,
                 second_approved_by_user_id = $3,
                 access_scope = $4,
                 status = $5,
                 starts_at = $6,
                 expires_at = $7,
                 revoked_at = $8
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.first_approved_by_user_id,
              record.second_approved_by_user_id,
              typeof record.access_scope === "string" ? record.access_scope : JSON.stringify(record.access_scope),
              record.status,
              record.starts_at,
              record.expires_at,
              record.revoked_at
            ]
          ),
          "Break-glass request"
        );
      },
      async listApprovedExpired(tenantId, nowIso) {
        return many(await execute(
          `SELECT * FROM break_glass_access
           WHERE tenant_id = $1 AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= $2`,
          [tenantId, nowIso]
        ));
      }
    },
    auditLogs: {
      async create(record) {
        try {
          return one(
            await execute(
              `INSERT INTO audit_logs (
                id, tenant_id, actor_type, actor_id, event_type, target_type, target_id,
                break_glass_access_id, metadata, created_at
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
              RETURNING *`,
              [
                record.id,
                record.tenant_id,
                record.actor_type,
                record.actor_id,
                record.event_type,
                record.target_type,
                record.target_id,
                record.break_glass_access_id,
                JSON.stringify(record.metadata ?? {}),
                record.created_at
              ]
            ),
            "Audit log"
          );
        } catch (err) {
          if (err.code === "23503") return record;
          throw err;
        }
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            "SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC",
            [tenantId]
          )
        );
      }
    },
    pentestFindings: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO pentest_findings (
              id, tenant_id, source, title, severity, category, status, affected_area,
              description, evidence, remediation_plan, owner_user_id, due_at, resolved_at,
              accepted_risk_reason, created_by_user_id, updated_by_user_id, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19
            )
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.source,
              record.title,
              record.severity,
              record.category,
              record.status,
              record.affected_area,
              record.description,
              JSON.stringify(record.evidence ?? {}),
              record.remediation_plan,
              record.owner_user_id,
              record.due_at,
              record.resolved_at,
              record.accepted_risk_reason,
              record.created_by_user_id,
              record.updated_by_user_id,
              record.created_at,
              record.updated_at
            ]
          ),
          "Pen-test finding"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            "SELECT * FROM pentest_findings WHERE tenant_id = $1 ORDER BY updated_at DESC",
            [tenantId]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM pentest_findings WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Pen-test finding"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE pentest_findings
             SET source = $3,
                 title = $4,
                 severity = $5,
                 category = $6,
                 status = $7,
                 affected_area = $8,
                 description = $9,
                 evidence = $10::jsonb,
                 remediation_plan = $11,
                 owner_user_id = $12,
                 due_at = $13,
                 resolved_at = $14,
                 accepted_risk_reason = $15,
                 updated_by_user_id = $16,
                 updated_at = $17
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.source,
              record.title,
              record.severity,
              record.category,
              record.status,
              record.affected_area,
              record.description,
              JSON.stringify(record.evidence ?? {}),
              record.remediation_plan,
              record.owner_user_id,
              record.due_at,
              record.resolved_at,
              record.accepted_risk_reason,
              record.updated_by_user_id,
              record.updated_at
            ]
          ),
          "Pen-test finding"
        );
      }
    },
    reportSnapshots: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO event_report_snapshots (
              id, tenant_id, event_id, report_snapshot_version, payload, created_at
            ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.report_snapshot_version,
              JSON.stringify(record.payload ?? {}),
              record.created_at
            ]
          ),
          "Report snapshot"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM event_report_snapshots
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      }
    },
    leaderboardSnapshots: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO leaderboard_snapshots (
              id, tenant_id, event_id, snapshot_version, calculation_version,
              snapshot_interval_minutes, payload, created_by_user_id, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.snapshot_version,
              record.calculation_version,
              record.snapshot_interval_minutes,
              JSON.stringify(record.payload ?? {}),
              record.created_by_user_id,
              record.created_at
            ]
          ),
          "Leaderboard snapshot"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM leaderboard_snapshots
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      }
    },
    crmSyncRecords: {
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO crm_sync_records (
              id, tenant_id, event_id, stall_id, interaction_id, provider, requested_by_user_id,
              status, external_record_id, request_payload, response_payload, last_error,
              synced_at, deleted_at, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16
            )
            ON CONFLICT (tenant_id, interaction_id, provider)
            DO UPDATE SET
              requested_by_user_id = EXCLUDED.requested_by_user_id,
              status = EXCLUDED.status,
              external_record_id = EXCLUDED.external_record_id,
              request_payload = EXCLUDED.request_payload,
              response_payload = EXCLUDED.response_payload,
              last_error = EXCLUDED.last_error,
              synced_at = EXCLUDED.synced_at,
              deleted_at = EXCLUDED.deleted_at,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.stall_id,
              record.interaction_id,
              record.provider,
              record.requested_by_user_id,
              record.status,
              record.external_record_id,
              JSON.stringify(record.request_payload ?? {}),
              JSON.stringify(record.response_payload ?? {}),
              record.last_error,
              record.synced_at,
              record.deleted_at,
              record.created_at,
              record.updated_at
            ]
          ),
          "CRM sync record"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM crm_sync_records
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY updated_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async listByInteraction(tenantId, interactionId) {
        return many(
          await execute(
            `SELECT * FROM crm_sync_records
             WHERE tenant_id = $1 AND interaction_id = $2
             ORDER BY updated_at DESC`,
            [tenantId, interactionId]
          )
        );
      },
      async findByInteractionAndProvider(tenantId, interactionId, provider) {
        const result = await execute(
          `SELECT * FROM crm_sync_records
           WHERE tenant_id = $1 AND interaction_id = $2 AND provider = $3`,
          [tenantId, interactionId, provider]
        );
        return result.rows[0] ?? null;
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM crm_sync_records
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "CRM sync record"
        );
      }
    },
    dataSubjectRequests: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO data_subject_requests (
              id, tenant_id, event_id, attendee_id, interaction_id, request_type, status,
              requested_by_user_id, request_reason, resolution_summary, result_payload,
              created_at, updated_at, completed_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14
            )
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.attendee_id,
              record.interaction_id,
              record.request_type,
              record.status,
              record.requested_by_user_id,
              record.request_reason,
              record.resolution_summary,
              JSON.stringify(record.result_payload ?? {}),
              record.created_at,
              record.updated_at,
              record.completed_at
            ]
          ),
          "Data-subject request"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM data_subject_requests
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM data_subject_requests
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "Data-subject request"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE data_subject_requests
             SET attendee_id = $2,
                 interaction_id = $3,
                 request_type = $4,
                 status = $5,
                 request_reason = $6,
                 resolution_summary = $7,
                 result_payload = $8::jsonb,
                 updated_at = $9,
                 completed_at = $10
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.attendee_id,
              record.interaction_id,
              record.request_type,
              record.status,
              record.request_reason,
              record.resolution_summary,
              JSON.stringify(record.result_payload ?? {}),
              record.updated_at,
              record.completed_at
            ]
          ),
          "Data-subject request"
        );
      },
      async listByAttendee(tenantId, attendeeId) {
        return many(await execute(
          `SELECT * FROM data_subject_requests WHERE tenant_id = $1 AND attendee_id = $2
           ORDER BY created_at DESC`,
          [tenantId, attendeeId]
        ));
      },
      async findActiveByAttendeeEventType(tenantId, attendeeId, eventId, requestType) {
        const result = await execute(
          `SELECT * FROM data_subject_requests
           WHERE tenant_id = $1 AND attendee_id = $2 AND event_id = $3 AND request_type = $4
             AND status IN ('requested','processing')
           LIMIT 1`,
          [tenantId, attendeeId, eventId, requestType]
        );
        return result.rows[0] ?? null;
      },
      async listByEventFiltered(tenantId, eventId, filters = {}) {
        const values = [tenantId, eventId];
        const conditions = ["tenant_id = $1", "event_id = $2"];
        if (filters.request_type) { values.push(filters.request_type); conditions.push(`request_type = $${values.length}`); }
        if (filters.status) { values.push(filters.status); conditions.push(`status = $${values.length}`); }
        const page = filters.page ?? 1;
        const pageSize = filters.page_size ?? 20;
        const countResult = await execute(
          `SELECT COUNT(*)::int AS total FROM data_subject_requests WHERE ${conditions.join(" AND ")}`, values
        );
        const total = countResult.rows[0]?.total ?? 0;
        values.push(pageSize, (page - 1) * pageSize);
        const items = many(await execute(
          `SELECT * FROM data_subject_requests WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values
        ));
        return { items, total };
      }
    },
    downstreamDeletionRecords: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO downstream_deletion_records (
              id, tenant_id, event_id, dsr_request_id, target_system, status, requested_at,
              confirmed_at, details, last_error, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11
            )
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.dsr_request_id,
              record.target_system,
              record.status,
              record.requested_at,
              record.confirmed_at,
              JSON.stringify(record.details ?? {}),
              record.last_error,
              record.updated_at
            ]
          ),
          "Downstream deletion record"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM downstream_deletion_records
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY requested_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async listByRequest(tenantId, dsrRequestId) {
        return many(
          await execute(
            `SELECT * FROM downstream_deletion_records
             WHERE tenant_id = $1 AND dsr_request_id = $2
             ORDER BY requested_at DESC`,
            [tenantId, dsrRequestId]
          )
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute(
            `SELECT * FROM downstream_deletion_records
             WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id]
          ),
          "Downstream deletion record"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE downstream_deletion_records
             SET status = $2,
                 confirmed_at = $3,
                 details = $4::jsonb,
                 last_error = $5,
                 updated_at = $6
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.status,
              record.confirmed_at,
              JSON.stringify(record.details ?? {}),
              record.last_error,
              record.updated_at
            ]
          ),
          "Downstream deletion record"
        );
      }
    },
    complianceRuns: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO compliance_runs (
              id, tenant_id, event_id, run_type, status, initiated_by, summary, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.run_type,
              record.status,
              record.initiated_by,
              JSON.stringify(record.summary ?? {}),
              record.created_at
            ]
          ),
          "Compliance run"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM compliance_runs
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async findLatestByEvent(tenantId, eventId) {
        const result = await execute(
          `SELECT * FROM compliance_runs
           WHERE tenant_id = $1 AND event_id = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [tenantId, eventId]
        );
        return result.rows[0] ?? null;
      }
    },
    pilotDryRunRecords: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO pilot_dry_run_records (
              id, tenant_id, event_id, execution_type, status, executed_by_user_id,
              summary, blockers, note, started_at, finished_at, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.execution_type,
              record.status,
              record.executed_by_user_id,
              JSON.stringify(record.summary ?? {}),
              JSON.stringify(record.blockers ?? []),
              record.note,
              record.started_at,
              record.finished_at,
              record.created_at,
              record.updated_at
            ]
          ),
          "Pilot dry-run record"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM pilot_dry_run_records
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY created_at DESC`,
            [tenantId, eventId]
          )
        );
      },
      async findLatestByEvent(tenantId, eventId) {
        const result = await execute(
          `SELECT * FROM pilot_dry_run_records
           WHERE tenant_id = $1 AND event_id = $2
           ORDER BY created_at DESC
           LIMIT 1`,
          [tenantId, eventId]
        );
        return result.rows[0] ?? null;
      }
    },
    pilotSignoffApprovals: {
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO pilot_signoff_approvals (
              id, tenant_id, event_id, approver_role, approver_label, approver_user_id,
              approval_status, note, approved_at, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (tenant_id, event_id, approver_role)
            DO UPDATE SET
              approver_label = EXCLUDED.approver_label,
              approver_user_id = EXCLUDED.approver_user_id,
              approval_status = EXCLUDED.approval_status,
              note = EXCLUDED.note,
              approved_at = EXCLUDED.approved_at,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.approver_role,
              record.approver_label,
              record.approver_user_id,
              record.approval_status,
              record.note,
              record.approved_at,
              record.created_at,
              record.updated_at
            ]
          ),
          "Pilot signoff approval"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM pilot_signoff_approvals
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY approver_role ASC`,
            [tenantId, eventId]
          )
        );
      }
    },
    finalLaunchApprovals: {
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO final_launch_approvals (
              id, tenant_id, event_id, approver_role, approver_label, approver_user_id,
              approval_status, note, approved_at, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (tenant_id, event_id, approver_role)
            DO UPDATE SET
              approver_label = EXCLUDED.approver_label,
              approver_user_id = EXCLUDED.approver_user_id,
              approval_status = EXCLUDED.approval_status,
              note = EXCLUDED.note,
              approved_at = EXCLUDED.approved_at,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.event_id,
              record.approver_role,
              record.approver_label,
              record.approver_user_id,
              record.approval_status,
              record.note,
              record.approved_at,
              record.created_at,
              record.updated_at
            ]
          ),
          "Final launch approval"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM final_launch_approvals
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY approver_role ASC`,
            [tenantId, eventId]
          )
        );
      }
    },
    commercialPartners: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO commercial_partners (
              id, tenant_id, name, partner_type, status, access_level, platform_user_id,
              notes, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.name,
              record.partner_type,
              record.status,
              record.access_level,
              record.platform_user_id,
              record.notes,
              record.created_at,
              record.updated_at
            ]
          ),
          "Commercial partner"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM commercial_partners WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Commercial partner"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            "SELECT * FROM commercial_partners WHERE tenant_id = $1 ORDER BY created_at DESC",
            [tenantId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE commercial_partners
             SET name = $3,
                 partner_type = $4,
                 status = $5,
                 access_level = $6,
                 platform_user_id = $7,
                 notes = $8,
                 updated_at = $9
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.name,
              record.partner_type,
              record.status,
              record.access_level,
              record.platform_user_id,
              record.notes,
              record.updated_at
            ]
          ),
          "Commercial partner"
        );
      }
    },
    commercialDeals: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO commercial_deals (
              id, tenant_id, partner_id, account_name, stage, next_action,
              next_action_at, offer_structure, commercial_positioning_ack,
              notes, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.partner_id,
              record.account_name,
              record.stage,
              record.next_action,
              record.next_action_at,
              record.offer_structure,
              record.commercial_positioning_ack,
              record.notes,
              record.created_at,
              record.updated_at
            ]
          ),
          "Commercial deal"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM commercial_deals WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Commercial deal"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute("SELECT * FROM commercial_deals WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId])
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE commercial_deals
             SET partner_id = $3,
                 account_name = $4,
                 stage = $5,
                 next_action = $6,
                 next_action_at = $7,
                 offer_structure = $8,
                 commercial_positioning_ack = $9,
                 notes = $10,
                 updated_at = $11
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.partner_id,
              record.account_name,
              record.stage,
              record.next_action,
              record.next_action_at,
              record.offer_structure,
              record.commercial_positioning_ack,
              record.notes,
              record.updated_at
            ]
          ),
          "Commercial deal"
        );
      }
    },
    commercialPartnerPayouts: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO commercial_partner_payouts (
              id, tenant_id, partner_id, deal_id, amount_cents, currency,
              status, client_payment_received_at, approved_by_user_id,
              approved_at, paid_at, notes, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.partner_id,
              record.deal_id,
              record.amount_cents,
              record.currency,
              record.status,
              record.client_payment_received_at,
              record.approved_by_user_id,
              record.approved_at,
              record.paid_at,
              record.notes,
              record.created_at,
              record.updated_at
            ]
          ),
          "Commercial partner payout"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM commercial_partner_payouts WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Commercial partner payout"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute(
            "SELECT * FROM commercial_partner_payouts WHERE tenant_id = $1 ORDER BY created_at DESC",
            [tenantId]
          )
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE commercial_partner_payouts
             SET partner_id = $3,
                 deal_id = $4,
                 amount_cents = $5,
                 currency = $6,
                 status = $7,
                 client_payment_received_at = $8,
                 approved_by_user_id = $9,
                 approved_at = $10,
                 paid_at = $11,
                 notes = $12,
                 updated_at = $13
             WHERE tenant_id = $1 AND id = $2
             RETURNING *`,
            [
              record.tenant_id,
              record.id,
              record.partner_id,
              record.deal_id,
              record.amount_cents,
              record.currency,
              record.status,
              record.client_payment_received_at,
              record.approved_by_user_id,
              record.approved_at,
              record.paid_at,
              record.notes,
              record.updated_at
            ]
          ),
          "Commercial partner payout"
        );
      }
    },
    commercialApprovals: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO commercial_approvals (
              id, tenant_id, approval_type, subject_id, requested_by_user_id,
              approver_user_id, approver_role, approval_status, reason,
              created_at, decided_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.approval_type,
              record.subject_id,
              record.requested_by_user_id,
              record.approver_user_id,
              record.approver_role,
              record.approval_status,
              record.reason,
              record.created_at,
              record.decided_at
            ]
          ),
          "Commercial approval"
        );
      },
      async listByTenant(tenantId) {
        return many(
          await execute("SELECT * FROM commercial_approvals WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId])
        );
      }
    },
    commercialPartnerStatusUpdates: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO commercial_partner_status_updates (
              id, tenant_id, partner_id, deal_id, update_type, summary,
              created_by_user_id, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            RETURNING *`,
            [
              record.id,
              record.tenant_id,
              record.partner_id,
              record.deal_id,
              record.update_type,
              record.summary,
              record.created_by_user_id,
              record.created_at
            ]
          ),
          "Commercial partner status update"
        );
      },
      async listByPartner(tenantId, partnerId) {
        return many(
          await execute(
            `SELECT * FROM commercial_partner_status_updates
             WHERE tenant_id = $1 AND partner_id = $2
             ORDER BY created_at DESC`,
            [tenantId, partnerId]
          )
        );
      }
    },
    iotSyncCheckpoints: {
      async findByIntegrationAndStream(integrationName, streamName) {
        const result = await db.query(
          `SELECT * FROM iot_sync_checkpoints
           WHERE integration_name = $1 AND stream_name = $2`,
          [integrationName, streamName]
        );
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await db.query(
            `INSERT INTO iot_sync_checkpoints (
              id, integration_name, stream_name, last_cursor, last_contract_version,
              last_environment, last_build_version, last_synced_at, updated_at, metadata
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
            ON CONFLICT (integration_name, stream_name)
            DO UPDATE SET
              last_cursor = EXCLUDED.last_cursor,
              last_contract_version = EXCLUDED.last_contract_version,
              last_environment = EXCLUDED.last_environment,
              last_build_version = EXCLUDED.last_build_version,
              last_synced_at = EXCLUDED.last_synced_at,
              updated_at = EXCLUDED.updated_at,
              metadata = EXCLUDED.metadata
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.stream_name,
              record.last_cursor,
              record.last_contract_version,
              record.last_environment,
              record.last_build_version,
              record.last_synced_at,
              record.updated_at,
              JSON.stringify(record.metadata ?? {})
            ]
          ),
          "IoT sync checkpoint"
        );
      }
    },
    iotCertificationStatuses: {
      async findByIntegration(integrationName) {
        const result = await db.query(
          `SELECT * FROM iot_certification_statuses
           WHERE integration_name = $1`,
          [integrationName]
        );
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await db.query(
            `INSERT INTO iot_certification_statuses (
              id, integration_name, status, contract_version, environment, build_version,
              last_checked_at, last_certified_at, last_failure_at, last_failure_message, metadata
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
            ON CONFLICT (integration_name)
            DO UPDATE SET
              status = EXCLUDED.status,
              contract_version = EXCLUDED.contract_version,
              environment = EXCLUDED.environment,
              build_version = EXCLUDED.build_version,
              last_checked_at = EXCLUDED.last_checked_at,
              last_certified_at = EXCLUDED.last_certified_at,
              last_failure_at = EXCLUDED.last_failure_at,
              last_failure_message = EXCLUDED.last_failure_message,
              metadata = EXCLUDED.metadata
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.status,
              record.contract_version,
              record.environment,
              record.build_version,
              record.last_checked_at,
              record.last_certified_at,
              record.last_failure_at,
              record.last_failure_message,
              JSON.stringify(record.metadata ?? {})
            ]
          ),
          "IoT certification status"
        );
      }
    },
    iotDeviceStatusSnapshots: {
      async findByDevice(tenantId, integrationName, deviceId) {
        const result = await execute(
          `SELECT * FROM iot_device_status_snapshots
           WHERE tenant_id = $1 AND integration_name = $2 AND device_id = $3`,
          [tenantId, integrationName, deviceId]
        );
        return result.rows[0] ?? null;
      },
      async listByEvent(tenantId, eventId) {
        return many(
          await execute(
            `SELECT * FROM iot_device_status_snapshots
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY checked_at DESC, device_id ASC`,
            [tenantId, eventId]
          )
        );
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO iot_device_status_snapshots (
              id, integration_name, tenant_id, event_id, device_id, platform_event_id, platform_stall_id,
              platform_assignment_checksum, iot_event_id, iot_stall_id, iot_assignment_checksum,
              lease_expires_at, assignment_status, diagnostics_status, connectivity_status, reader_status,
              app_version, firmware_version, local_queue_depth, last_heartbeat_at, open_incident_code,
              open_incident_status, open_incident_severity, checked_at, metadata
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb
            )
            ON CONFLICT (integration_name, device_id)
            DO UPDATE SET
              tenant_id = EXCLUDED.tenant_id,
              event_id = EXCLUDED.event_id,
              platform_event_id = EXCLUDED.platform_event_id,
              platform_stall_id = EXCLUDED.platform_stall_id,
              platform_assignment_checksum = EXCLUDED.platform_assignment_checksum,
              iot_event_id = EXCLUDED.iot_event_id,
              iot_stall_id = EXCLUDED.iot_stall_id,
              iot_assignment_checksum = EXCLUDED.iot_assignment_checksum,
              lease_expires_at = EXCLUDED.lease_expires_at,
              assignment_status = EXCLUDED.assignment_status,
              diagnostics_status = EXCLUDED.diagnostics_status,
              connectivity_status = EXCLUDED.connectivity_status,
              reader_status = EXCLUDED.reader_status,
              app_version = EXCLUDED.app_version,
              firmware_version = EXCLUDED.firmware_version,
              local_queue_depth = EXCLUDED.local_queue_depth,
              last_heartbeat_at = EXCLUDED.last_heartbeat_at,
              open_incident_code = EXCLUDED.open_incident_code,
              open_incident_status = EXCLUDED.open_incident_status,
              open_incident_severity = EXCLUDED.open_incident_severity,
              checked_at = EXCLUDED.checked_at,
              metadata = EXCLUDED.metadata
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.tenant_id,
              record.event_id,
              record.device_id,
              record.platform_event_id,
              record.platform_stall_id,
              record.platform_assignment_checksum,
              record.iot_event_id,
              record.iot_stall_id,
              record.iot_assignment_checksum,
              record.lease_expires_at,
              record.assignment_status,
              record.diagnostics_status,
              record.connectivity_status,
              record.reader_status,
              record.app_version,
              record.firmware_version,
              record.local_queue_depth,
              record.last_heartbeat_at,
              record.open_incident_code,
              record.open_incident_status,
              record.open_incident_severity,
              record.checked_at,
              JSON.stringify(record.metadata ?? {})
            ]
          ),
          "IoT device status snapshot"
        );
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const result = await execute(
          `DELETE FROM iot_device_status_snapshots
           WHERE tenant_id = $1 AND event_id = $2 AND checked_at < $3`,
          [tenantId, eventId, olderThanIso]
        );
        return result.rowCount ?? 0;
      }
    },
    iotIntegrationHealthStatuses: {
      async findByEvent(tenantId, integrationName, eventId) {
        const result = await execute(
          `SELECT * FROM iot_integration_health_statuses
           WHERE tenant_id = $1 AND integration_name = $2 AND event_id = $3`,
          [tenantId, integrationName, eventId]
        );
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO iot_integration_health_statuses (
              id, integration_name, tenant_id, event_id, overall_status, certification_status,
              contract_version, environment, build_version, stale_after_seconds, warning_count,
              checked_at, warnings, metrics, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16
            )
            ON CONFLICT (integration_name, tenant_id, event_id)
            DO UPDATE SET
              overall_status = EXCLUDED.overall_status,
              certification_status = EXCLUDED.certification_status,
              contract_version = EXCLUDED.contract_version,
              environment = EXCLUDED.environment,
              build_version = EXCLUDED.build_version,
              stale_after_seconds = EXCLUDED.stale_after_seconds,
              warning_count = EXCLUDED.warning_count,
              checked_at = EXCLUDED.checked_at,
              warnings = EXCLUDED.warnings,
              metrics = EXCLUDED.metrics,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.tenant_id,
              record.event_id,
              record.overall_status,
              record.certification_status,
              record.contract_version,
              record.environment,
              record.build_version,
              record.stale_after_seconds,
              record.warning_count,
              record.checked_at,
              JSON.stringify(record.warnings ?? []),
              JSON.stringify(record.metrics ?? {}),
              record.created_at,
              record.updated_at
            ]
          ),
          "IoT integration health status"
        );
      }
    },
    iotIntegrationRuns: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO iot_integration_runs (
              id, integration_name, tenant_id, event_id, trigger_mode, initiated_by, status,
              step_count, failed_step_count, warning_count, started_at, finished_at, steps,
              summary, error_summary, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17
            )
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.tenant_id,
              record.event_id,
              record.trigger_mode,
              record.initiated_by,
              record.status,
              record.step_count,
              record.failed_step_count,
              record.warning_count,
              record.started_at,
              record.finished_at,
              JSON.stringify(record.steps ?? []),
              JSON.stringify(record.summary ?? {}),
              record.error_summary,
              record.created_at,
              record.updated_at
            ]
          ),
          "IoT integration run"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE iot_integration_runs
             SET status = $2,
                 step_count = $3,
                 failed_step_count = $4,
                 warning_count = $5,
                 finished_at = $6,
                 steps = $7::jsonb,
                 summary = $8::jsonb,
                 error_summary = $9,
                 updated_at = $10
             WHERE id = $1
             RETURNING *`,
            [
              record.id,
              record.status,
              record.step_count,
              record.failed_step_count,
              record.warning_count,
              record.finished_at,
              JSON.stringify(record.steps ?? []),
              JSON.stringify(record.summary ?? {}),
              record.error_summary,
              record.updated_at
            ]
          ),
          "IoT integration run"
        );
      },
      async listByEvent(tenantId, eventId, options = {}) {
        const limit = Number(options.limit ?? 20);
        return many(
          await execute(
            `SELECT * FROM iot_integration_runs
             WHERE tenant_id = $1 AND event_id = $2
             ORDER BY started_at DESC
             LIMIT $3`,
            [tenantId, eventId, limit]
          )
        );
      },
      async findLatestByEvent(tenantId, integrationName, eventId) {
        const result = await execute(
          `SELECT * FROM iot_integration_runs
           WHERE tenant_id = $1 AND integration_name = $2 AND event_id = $3
           ORDER BY started_at DESC
           LIMIT 1`,
          [tenantId, integrationName, eventId]
        );
        return result.rows[0] ?? null;
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const result = await execute(
          `DELETE FROM iot_integration_runs
           WHERE tenant_id = $1 AND event_id = $2 AND started_at < $3`,
          [tenantId, eventId, olderThanIso]
        );
        return result.rowCount ?? 0;
      }
    },
    iotAlertEvents: {
      async findByDedupeKey(tenantId, dedupeKey) {
        const result = await execute(
          `SELECT * FROM iot_alert_events
           WHERE tenant_id = $1 AND dedupe_key = $2`,
          [tenantId, dedupeKey]
        );
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO iot_alert_events (
              id, integration_name, tenant_id, event_id, source_type, source_id, dedupe_key,
              severity, status, code, message, details, delivery_status, routed_destinations,
              last_delivery_at, delivery_error, created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16,$17,$18
            )
            ON CONFLICT (dedupe_key)
            DO UPDATE SET
              source_id = EXCLUDED.source_id,
              severity = EXCLUDED.severity,
              status = EXCLUDED.status,
              code = EXCLUDED.code,
              message = EXCLUDED.message,
              details = EXCLUDED.details,
              delivery_status = EXCLUDED.delivery_status,
              routed_destinations = EXCLUDED.routed_destinations,
              last_delivery_at = EXCLUDED.last_delivery_at,
              delivery_error = EXCLUDED.delivery_error,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.tenant_id,
              record.event_id,
              record.source_type,
              record.source_id,
              record.dedupe_key,
              record.severity,
              record.status,
              record.code,
              record.message,
              JSON.stringify(record.details ?? {}),
              record.delivery_status,
              JSON.stringify(record.routed_destinations ?? []),
              record.last_delivery_at,
              record.delivery_error,
              record.created_at,
              record.updated_at
            ]
          ),
          "IoT alert event"
        );
      },
      async listByEvent(tenantId, eventId, options = {}) {
        const limit = Number(options.limit ?? 20);
        const params = [tenantId, eventId];
        let where = "tenant_id = $1 AND event_id = $2";
        if (options.status) {
          params.push(options.status);
          where += ` AND status = $${params.length}`;
        }
        params.push(limit);
        return many(
          await execute(
            `SELECT * FROM iot_alert_events
             WHERE ${where}
             ORDER BY created_at DESC
             LIMIT $${params.length}`,
            params
          )
        );
      },
      async countOpenByEvent(tenantId, eventId) {
        const result = await execute(
          `SELECT COUNT(*)::integer AS count
           FROM iot_alert_events
           WHERE tenant_id = $1 AND event_id = $2 AND status = 'open'`,
          [tenantId, eventId]
        );
        return result.rows[0]?.count ?? 0;
      },
      async resolveOpenByCodes(tenantId, eventId, codes, resolvedAt) {
        if (!codes.length) {
          return 0;
        }
        const result = await execute(
          `UPDATE iot_alert_events
           SET status = 'resolved',
               updated_at = $4
           WHERE tenant_id = $1
             AND event_id = $2
             AND status = 'open'
             AND code = ANY($3::text[])`,
          [tenantId, eventId, codes, resolvedAt]
        );
        return result.rowCount ?? 0;
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const result = await execute(
          `DELETE FROM iot_alert_events
           WHERE tenant_id = $1 AND event_id = $2 AND updated_at < $3`,
          [tenantId, eventId, olderThanIso]
        );
        return result.rowCount ?? 0;
      }
    },
    iotEnvironmentParityStatuses: {
      async findByEvent(tenantId, integrationName, eventId) {
        const result = await execute(
          `SELECT * FROM iot_environment_parity_statuses
           WHERE tenant_id = $1 AND integration_name = $2 AND event_id = $3`,
          [tenantId, integrationName, eventId]
        );
        return result.rows[0] ?? null;
      },
      async upsert(record) {
        return one(
          await execute(
            `INSERT INTO iot_environment_parity_statuses (
              id, integration_name, tenant_id, event_id, status, staging_contract_version,
              staging_environment, staging_build_version, production_contract_version,
              production_environment, production_build_version, checked_at, issues, details,
              created_at, updated_at
            ) VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16
            )
            ON CONFLICT (integration_name, tenant_id, event_id)
            DO UPDATE SET
              status = EXCLUDED.status,
              staging_contract_version = EXCLUDED.staging_contract_version,
              staging_environment = EXCLUDED.staging_environment,
              staging_build_version = EXCLUDED.staging_build_version,
              production_contract_version = EXCLUDED.production_contract_version,
              production_environment = EXCLUDED.production_environment,
              production_build_version = EXCLUDED.production_build_version,
              checked_at = EXCLUDED.checked_at,
              issues = EXCLUDED.issues,
              details = EXCLUDED.details,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
            [
              record.id,
              record.integration_name,
              record.tenant_id,
              record.event_id,
              record.status,
              record.staging_contract_version,
              record.staging_environment,
              record.staging_build_version,
              record.production_contract_version,
              record.production_environment,
              record.production_build_version,
              record.checked_at,
              JSON.stringify(record.issues ?? []),
              JSON.stringify(record.details ?? {}),
              record.created_at,
              record.updated_at
            ]
          ),
          "IoT environment parity status"
        );
      },
      async deleteOlderThanByEvent(tenantId, eventId, olderThanIso) {
        const result = await execute(
          `DELETE FROM iot_environment_parity_statuses
           WHERE tenant_id = $1 AND event_id = $2 AND checked_at < $3`,
          [tenantId, eventId, olderThanIso]
        );
        return result.rowCount ?? 0;
      }
    },
    sponsorPackages: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO sponsor_packages (id, tenant_id, event_id, name, description, tier, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [
              record.id, record.tenant_id, record.event_id, record.name,
              record.description ?? null, record.tier ?? "bronze",
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "Sponsor package"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM sponsor_packages WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "Sponsor package"
        );
      },
      async listByEvent(tenantId, eventId) {
        return many(await execute(
          "SELECT * FROM sponsor_packages WHERE tenant_id = $1 AND event_id = $2 ORDER BY created_at DESC",
          [tenantId, eventId]
        ));
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE sponsor_packages SET name=$2, description=$3, tier=$4 WHERE id=$1 RETURNING *`,
            [record.id, record.name, record.description ?? null, record.tier ?? "bronze"]
          ),
          "Sponsor package"
        );
      },
      async deleteById(tenantId, id) {
        return one(
          await execute("DELETE FROM sponsor_packages WHERE tenant_id=$1 AND id=$2 RETURNING *", [tenantId, id]),
          "Sponsor package"
        );
      }
    },
    brandingAssets: {
      async findActiveByEvent(tenantId, eventId) {
        const result = await execute(
          "SELECT * FROM branding_assets WHERE tenant_id = $1 AND event_id = $2 AND status = 'active' LIMIT 1",
          [tenantId, eventId]
        );
        return result.rows[0] ?? null;
      },
      async create(record) {
        return one(
          await execute(
            `INSERT INTO branding_assets (
              id, tenant_id, event_id, version, status, idle_headline, idle_sub, tap_cta,
              sponsor_name, sponsor_logo_url, sponsor_cta, event_logo_url, primary_color,
              background_color, attendee_landing_message, attendee_privacy_url,
              published_by_user_id, note, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
            RETURNING *`,
            [
              record.id, record.tenant_id, record.event_id, record.version ?? 1,
              record.status ?? "draft",
              record.idle_headline ?? "Tap your phone to connect",
              record.idle_sub ?? "Hold your NFC device near the reader",
              record.tap_cta ?? "Tap to exchange contact details",
              record.sponsor_name ?? null, record.sponsor_logo_url ?? null,
              record.sponsor_cta ?? null, record.event_logo_url ?? null,
              record.primary_color ?? "#38e8a6", record.background_color ?? "#050d18",
              record.attendee_landing_message ?? "Contact exchange successful",
              record.attendee_privacy_url ?? null, record.published_by_user_id ?? null,
              record.note ?? null,
              record.created_at ?? new Date().toISOString(),
              record.updated_at ?? new Date().toISOString()
            ]
          ),
          "Branding asset"
        );
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE branding_assets SET status=$2, idle_headline=$3, idle_sub=$4, tap_cta=$5,
             sponsor_name=$6, sponsor_logo_url=$7, sponsor_cta=$8, event_logo_url=$9,
             primary_color=$10, background_color=$11, attendee_landing_message=$12,
             attendee_privacy_url=$13, note=$14, updated_at=$15
             WHERE id=$1 RETURNING *`,
            [
              record.id, record.status, record.idle_headline, record.idle_sub, record.tap_cta,
              record.sponsor_name ?? null, record.sponsor_logo_url ?? null,
              record.sponsor_cta ?? null, record.event_logo_url ?? null,
              record.primary_color, record.background_color,
              record.attendee_landing_message, record.attendee_privacy_url ?? null,
              record.note ?? null, record.updated_at ?? new Date().toISOString()
            ]
          ),
          "Branding asset"
        );
      }
    },
    userRoleAssignments: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO user_role_assignments (
              id, tenant_id, user_id, role, event_id, stall_ids, sponsor_package_id,
              assigned_by_user_id, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              record.id, record.tenant_id, record.user_id, record.role,
              record.event_id ?? null, record.stall_ids ?? null,
              record.sponsor_package_id ?? null, record.assigned_by_user_id,
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "User role assignment"
        );
      },
      async findById(tenantId, id) {
        return one(
          await execute("SELECT * FROM user_role_assignments WHERE tenant_id = $1 AND id = $2", [tenantId, id]),
          "User role assignment"
        );
      },
      async listByTenant(tenantId) {
        return many(await execute(
          "SELECT * FROM user_role_assignments WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]
        ));
      },
      async listByUser(tenantId, userId) {
        return many(await execute(
          "SELECT * FROM user_role_assignments WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC",
          [tenantId, userId]
        ));
      },
      async deleteById(tenantId, id) {
        return one(
          await execute("DELETE FROM user_role_assignments WHERE tenant_id=$1 AND id=$2 RETURNING *", [tenantId, id]),
          "User role assignment"
        );
      }
    },
    apiClients: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO api_clients (id, tenant_id, name, secret_hash, status,
             created_by_user_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [
              record.id, record.tenant_id, record.name,
              record.client_secret_hash ?? record.secret_hash,
              record.status ?? "active",
              record.created_by_user_id ?? null,
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "API client"
        );
      },
      async findById(tenantId, id) {
        const result = await execute(
          "SELECT *, secret_hash AS client_secret_hash FROM api_clients WHERE tenant_id = $1 AND id = $2",
          [tenantId, id]
        );
        if (!result.rows[0]) throw new HttpError(404, "API client not found");
        return result.rows[0];
      },
      async listByTenant(tenantId) {
        return many(await execute(
          "SELECT *, secret_hash AS client_secret_hash FROM api_clients WHERE tenant_id = $1 ORDER BY created_at DESC",
          [tenantId]
        ));
      },
      async findBySecretHash(secretHash) {
        const result = await execute(
          "SELECT *, secret_hash AS client_secret_hash FROM api_clients WHERE secret_hash = $1 LIMIT 1",
          [secretHash]
        );
        return result.rows[0] ?? null;
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE api_clients SET name=$2, secret_hash=$3, status=$4,
             last_used_at=$5, revoked_by_user_id=$6, revoked_at=$7
             WHERE id=$1 RETURNING *, secret_hash AS client_secret_hash`,
            [
              record.id, record.name,
              record.client_secret_hash ?? record.secret_hash,
              record.status, record.last_used_at ?? null,
              record.revoked_by_user_id ?? null, record.revoked_at ?? null
            ]
          ),
          "API client"
        );
      }
    },
    nfcReaders: {
      async create(record) { return record; },
      async findById(_tenantId, _id) { return null; },
      async findByDevice(_tenantId, _deviceId) { return null; },
      async update(record) { return record; }
    },
    privacyAuditLogs: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO privacy_audit_log (
              id, tenant_id, event_id, actor_user_id, actor_role, action,
              target_type, target_id, metadata, occurred_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
            [
              record.id ?? `pal-${Date.now()}`,
              record.tenant_id, record.event_id ?? null,
              record.actor_user_id ?? null, record.actor_role,
              record.action, record.target_type ?? null, record.target_id ?? null,
              JSON.stringify(record.metadata ?? {}),
              record.occurred_at ?? new Date().toISOString()
            ]
          ),
          "Privacy audit log"
        );
      },
      async listByTenant(tenantId, filters = {}) {
        const values = [tenantId];
        const conditions = ["tenant_id = $1"];
        if (filters.event_id) { values.push(filters.event_id); conditions.push(`event_id = $${values.length}`); }
        if (filters.action) { values.push(filters.action); conditions.push(`action = $${values.length}`); }
        if (filters.actor_role) { values.push(filters.actor_role); conditions.push(`actor_role = $${values.length}`); }
        if (filters.from) { values.push(filters.from); conditions.push(`occurred_at >= $${values.length}`); }
        if (filters.to) { values.push(filters.to); conditions.push(`occurred_at <= $${values.length}`); }
        const page = filters.page ?? 1;
        const pageSize = filters.page_size ?? 20;
        const countResult = await execute(
          `SELECT COUNT(*)::int AS total FROM privacy_audit_log WHERE ${conditions.join(" AND ")}`, values
        );
        const total = countResult.rows[0]?.total ?? 0;
        values.push(pageSize, (page - 1) * pageSize);
        const entries = many(await execute(
          `SELECT * FROM privacy_audit_log WHERE ${conditions.join(" AND ")}
           ORDER BY occurred_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
          values
        ));
        return { entries, total, page, page_size: pageSize };
      }
    },
    tenantOffboardingJobs: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO tenant_offboarding_jobs (
              id, tenant_id, initiated_by_user_id, approved_by_user_id,
              data_handling_path, grace_period_days, status, export_file_url,
              deletion_certificate_url, scheduled_deletion_at, completed_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [
              record.id, record.tenant_id, record.initiated_by_user_id ?? null,
              record.approved_by_user_id ?? null, record.data_handling_path,
              record.grace_period_days ?? null, record.status ?? "initiated",
              record.export_file_url ?? null, record.deletion_certificate_url ?? null,
              record.scheduled_deletion_at ?? null, record.completed_at ?? null,
              record.created_at ?? new Date().toISOString()
            ]
          ),
          "Tenant offboarding job"
        );
      },
      async findById(id) {
        const result = await execute("SELECT * FROM tenant_offboarding_jobs WHERE id = $1", [id]);
        return result.rows[0] ?? null;
      },
      async findActiveByTenant(tenantId) {
        const result = await execute(
          `SELECT * FROM tenant_offboarding_jobs
           WHERE tenant_id = $1 AND status NOT IN ('completed','failed')
           ORDER BY created_at DESC LIMIT 1`,
          [tenantId]
        );
        return result.rows[0] ?? null;
      },
      async update(record) {
        return one(
          await execute(
            `UPDATE tenant_offboarding_jobs SET approved_by_user_id=$2, status=$3,
             export_file_url=$4, deletion_certificate_url=$5, scheduled_deletion_at=$6,
             completed_at=$7 WHERE id=$1 RETURNING *`,
            [
              record.id, record.approved_by_user_id ?? null, record.status,
              record.export_file_url ?? null, record.deletion_certificate_url ?? null,
              record.scheduled_deletion_at ?? null, record.completed_at ?? null
            ]
          ),
          "Tenant offboarding job"
        );
      }
    },
    crmConnections: {
      async findById(id) {
        const result = await execute("SELECT * FROM crm_connections WHERE id = $1", [id]);
        return result.rows[0] ?? null;
      },
      async listByTenant(tenantId) {
        return many(await execute(
          "SELECT * FROM crm_connections WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]
        ));
      }
    },
    crmSyncJobs: {
      async create(record) {
        return one(
          await execute(
            `INSERT INTO crm_sync_jobs (
              id, tenant_id, interaction_id, connection_id, provider, target_object,
              status, external_record_id, last_error, attempt_count,
              consent_verified_at, consent_valid, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [
              record.id, record.tenant_id, record.interaction_id,
              record.connection_id ?? null, record.provider,
              record.target_object ?? "lead", record.status ?? "queued",
              record.external_record_id ?? null, record.last_error ?? null,
              record.attempt_count ?? 0, record.consent_verified_at ?? null,
              record.consent_valid ?? null,
              record.created_at ?? new Date().toISOString(),
              record.updated_at ?? new Date().toISOString()
            ]
          ),
          "CRM sync job"
        );
      },
      async findByAttendeeId(attendeeId) {
        return many(await execute(
          `SELECT csj.* FROM crm_sync_jobs csj
           JOIN interactions i ON i.id = csj.interaction_id
           JOIN attendees a ON a.id = i.attendee_id
           WHERE a.id = $1`,
          [attendeeId]
        ));
      },
      async update(id, fields) {
        const sets = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(", ");
        return one(
          await execute(
            `UPDATE crm_sync_jobs SET ${sets} WHERE id = $1 RETURNING *`,
            [id, ...Object.values(fields)]
          ),
          "CRM sync job"
        );
      }
    },
    metrics: {
      incrementRouteHit() {
        return undefined;
      }
    }
  };

  return repos;
}

function one(result, label) {
  return rowOrThrow(result, label);
}

function many(result) {
  return result.rows;
}

function maybeOne(result) {
  return result.rows[0] ?? null;
}
