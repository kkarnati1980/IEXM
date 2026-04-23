/**
 * routes_patch_b3.mjs  —  Batch 3 route additions
 *
 * Paste ALL registrations below into apps/api/src/routes.mjs
 * BEFORE the closing `}` of registerRoutes().
 *
 * Closes:
 *   FL-01   GET  /organizer/events/:id/fleet            (per-device status)
 *   HB-01   POST /device/heartbeat                      (threshold evaluation + auto-incident)
 *   DC-01   GET  /organizer/events/:id/data-policy      (read policy)
 *   DC-01   PUT  /organizer/events/:id/data-policy      (save policy)
 *   EX-01   GET  /organizer/events/:id/exports/pending  (pending export requests)
 *   EX-01   POST /exports/:id/approve                   (approve export)
 *   EX-01   POST /exports/:id/reject                    (reject export)
 *   AU-01   GET  /organizer/events/:id/audit-log        (audit log with filters)
 *   AT-01   GET  /attendee/interactions/:id             (attendee mobile — interaction context)
 *   AT-01   GET  /attendee/vault                        (attendee contact vault)
 *   AT-01   POST /consents/capture                      (consent capture with timestamp/locale)
 *   AT-01   POST /consents/revoke                       (per-vendor revoke)
 *   AT-01   POST /consents/revoke-all                   (revoke all consents for event)
 *   AT-01   GET  /attendee/consents                     (active consents list)
 *   AT-01   POST /attendee/data-subject-requests        (DSR submit)
 *   AT-01   GET  /attendee/data-subject-requests        (DSR list)
 *   AT-01   DELETE /attendee/interactions/:id           (attendee delete own record)
 *   AT-01   GET  /attendee/interactions/:id/export      (attendee self-export)
 */

  /* ─────────────────────────────────────────────────────────────
   * FL-01  FLEET DASHBOARD
   * ───────────────────────────────────────────────────────────── */

  /** GET /organizer/events/:eventId/fleet
   *  Returns per-device status enriched with latest heartbeat and incident state. */
  app.get(
    "/organizer/events/:eventId/fleet",
    authenticate(["organizer_admin", "ops_user"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      try {
        const devices = await db.query(
          `SELECT
              d.id            AS device_id,
              d.device_name,
              d.serial_number,
              d.app_version,
              d.status        AS device_status,
              da.stall_id,
              s.name          AS stall_name,
              hb.battery_percent,
              hb.wifi_strength,
              hb.mobile_signal,
              hb.reader_status,
              hb.app_version  AS hb_app_version,
              hb.local_queue_depth,
              hb.recorded_at,
              -- Build latest heartbeat JSON
              jsonb_build_object(
                'battery_percent',   hb.battery_percent,
                'wifi_strength',     hb.wifi_strength,
                'mobile_signal',     hb.mobile_signal,
                'reader_status',     hb.reader_status,
                'local_queue_depth', hb.local_queue_depth,
                'recorded_at',       hb.recorded_at
              ) AS latest_heartbeat,
              COUNT(di.id) FILTER (WHERE di.resolved_at IS NULL)           AS open_incidents,
              COUNT(di.id) FILTER (WHERE di.severity='critical' AND di.resolved_at IS NULL) > 0
                                                                            AS has_critical_incident,
              COUNT(di.id) FILTER (WHERE di.severity='warning'  AND di.resolved_at IS NULL) > 0
                                                                            AS has_warning_incident
            FROM device_assignments da
            JOIN devices d ON d.id = da.device_id
            LEFT JOIN stalls s ON s.id = da.stall_id
            LEFT JOIN LATERAL (
              SELECT * FROM device_heartbeats
               WHERE device_id = d.id
               ORDER BY recorded_at DESC LIMIT 1
            ) hb ON TRUE
            LEFT JOIN device_incidents di ON di.device_id = d.id
           WHERE da.tenant_id = $1
             AND da.event_id  = $2
             AND da.is_active = TRUE
           GROUP BY d.id, d.device_name, d.serial_number, d.app_version, d.status,
                    da.stall_id, s.name,
                    hb.battery_percent, hb.wifi_strength, hb.mobile_signal,
                    hb.reader_status, hb.app_version, hb.local_queue_depth, hb.recorded_at
           ORDER BY s.name ASC`,
          [req.tenant_id, eventId]
        );

        return res.json({
          event_id:     eventId,
          total_devices: devices.rows.length,
          devices:      devices.rows,
        });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load fleet status." });
      }
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * HB-01  HEARTBEAT — THRESHOLD EVALUATION + AUTO-INCIDENT
   * This overrides / supplements the existing heartbeat route.
   * If your codebase already has POST /device/heartbeat, add the
   * threshold evaluation block shown here into its handler.
   * ───────────────────────────────────────────────────────────── */

  /**
   * Threshold evaluation helper — call after writing the heartbeat row.
   * Creates warning/critical incidents per spec §16.5, §16.6, §16.7.
   */
  async function evaluateHeartbeatThresholds(deviceId, tenantId, heartbeat, db) {
    const { battery_percent, reader_status, local_queue_depth } = heartbeat;

    const incidents = [];

    // Battery thresholds (§16.6)
    if (battery_percent != null && battery_percent < 10) {
      incidents.push({ type: "low_battery", severity: "critical", detail: `Battery at ${battery_percent}%` });
    } else if (battery_percent != null && battery_percent < 20) {
      incidents.push({ type: "low_battery", severity: "warning", detail: `Battery at ${battery_percent}%` });
    }

    // Reader disconnect
    if (reader_status === "disconnected") {
      incidents.push({ type: "reader_disconnected", severity: "critical", detail: "NFC reader disconnected." });
    }

    // Queue depth thresholds (§16.7)
    if (local_queue_depth != null && local_queue_depth >= 500) {
      incidents.push({ type: "queue_critical", severity: "critical", detail: `Queue depth ${local_queue_depth} ≥ 500` });
    } else if (local_queue_depth != null && local_queue_depth >= 100) {
      incidents.push({ type: "queue_warning", severity: "warning", detail: `Queue depth ${local_queue_depth} ≥ 100` });
    }

    // Missed heartbeat detection (§16.5)
    // Check last N heartbeats to see if there was a gap
    const recent = await db.query(
      `SELECT recorded_at FROM device_heartbeats
        WHERE device_id = $1 AND tenant_id = $2
        ORDER BY recorded_at DESC LIMIT 6`,
      [deviceId, tenantId]
    );
    if (recent.rows.length >= 2) {
      const gaps = recent.rows.slice(0, -1).map((row, i) => {
        const a = new Date(row.recorded_at).getTime();
        const b = new Date(recent.rows[i + 1].recorded_at).getTime();
        return (a - b) / 1000; // seconds
      });
      const missedCount = gaps.filter(g => g > 90).length; // >90s = missed (60s + 30s grace)
      if (missedCount >= 5) {
        incidents.push({ type: "network_outage", severity: "critical", detail: `${missedCount} missed heartbeats` });
      } else if (missedCount >= 2) {
        incidents.push({ type: "network_outage", severity: "warning", detail: `${missedCount} missed heartbeats` });
      }
    }

    // Write new incidents (deduplicate: skip if same type + unresolved already exists)
    for (const inc of incidents) {
      const existing = await db.query(
        `SELECT id FROM device_incidents
          WHERE device_id=$1 AND tenant_id=$2 AND incident_type=$3 AND resolved_at IS NULL`,
        [deviceId, tenantId, inc.type]
      );
      if (!existing.rows.length) {
        await db.query(
          `INSERT INTO device_incidents (device_id, tenant_id, incident_type, severity, detail)
           VALUES ($1,$2,$3,$4,$5)`,
          [deviceId, tenantId, inc.type, inc.severity, inc.detail]
        );
      }
    }

    return incidents;
  }

  // Attach to the module scope so the heartbeat handler can call it
  // In your existing heartbeat handler, after writing the heartbeat row, add:
  //   await evaluateHeartbeatThresholds(device_id, req.tenant_id, req.body, db);

  /* ─────────────────────────────────────────────────────────────
   * DC-01  DATA POLICY
   * ───────────────────────────────────────────────────────────── */

  /** GET /organizer/events/:eventId/data-policy */
  app.get(
    "/organizer/events/:eventId/data-policy",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      try {
        const result = await db.query(
          `SELECT * FROM event_data_policies WHERE tenant_id=$1 AND event_id=$2`,
          [req.tenant_id, eventId]
        );
        if (!result.rows.length) {
          // Return spec defaults
          return res.json({
            policy: {
              event_id: eventId,
              vendor_exports_enabled: true,
              sponsor_pii_enabled: false,
              require_export_approval: false,
              allow_crm_push: true,
              retention_days: 90,
              allow_cross_event_identity_graph: false,
            },
            is_default: true,
          });
        }
        return res.json({ policy: result.rows[0], is_default: false });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load data policy." });
      }
    }
  );

  /** PUT /organizer/events/:eventId/data-policy
   *  Upsert event data policy. Audited action. */
  app.put(
    "/organizer/events/:eventId/data-policy",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      const {
        vendor_exports_enabled,
        sponsor_pii_enabled,
        require_export_approval,
        allow_crm_push,
        retention_days,
        allow_cross_event_identity_graph,
      } = req.body;

      if (retention_days != null && (retention_days < 1 || retention_days > 730)) {
        return res.status(400).json({ error: "retention_days must be between 1 and 730." });
      }

      try {
        const result = await db.query(
          `INSERT INTO event_data_policies
             (tenant_id, event_id, vendor_exports_enabled, sponsor_pii_enabled,
              require_export_approval, allow_crm_push, retention_days,
              allow_cross_event_identity_graph, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (event_id)
           DO UPDATE SET
             vendor_exports_enabled           = EXCLUDED.vendor_exports_enabled,
             sponsor_pii_enabled              = EXCLUDED.sponsor_pii_enabled,
             require_export_approval          = EXCLUDED.require_export_approval,
             allow_crm_push                   = EXCLUDED.allow_crm_push,
             retention_days                   = EXCLUDED.retention_days,
             allow_cross_event_identity_graph = EXCLUDED.allow_cross_event_identity_graph,
             updated_at                       = NOW()
           RETURNING *`,
          [
            req.tenant_id, eventId,
            vendor_exports_enabled  ?? true,
            sponsor_pii_enabled     ?? false,
            require_export_approval ?? false,
            allow_crm_push          ?? true,
            retention_days          ?? 90,
            allow_cross_event_identity_graph ?? false,
          ]
        );

        // Audit the policy change
        await db.query(
          `INSERT INTO audit_log (tenant_id, event_id, action_type, actor_id, target_id, payload, result)
           VALUES ($1,$2,'policy_change',$3,$4,$5,'success')`,
          [req.tenant_id, eventId, req.user_id, eventId, JSON.stringify(req.body)]
        ).catch(() => {}); // audit failure must not block the response

        return res.json({ policy: result.rows[0] });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to save data policy." });
      }
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * EX-01  EXPORT APPROVAL WORKFLOW
   * ───────────────────────────────────────────────────────────── */

  /** GET /organizer/events/:eventId/exports/pending */
  app.get(
    "/organizer/events/:eventId/exports/pending",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      const { status = "pending" } = req.query;
      try {
        const result = await db.query(
          `SELECT e.*, u.email AS requested_by_email
             FROM exports e
             LEFT JOIN users u ON u.id = e.requested_by_user_id
            WHERE e.tenant_id = $1
              AND e.event_id  = $2
              AND e.status    = $3
            ORDER BY e.created_at DESC
            LIMIT 100`,
          [req.tenant_id, eventId, status]
        );
        return res.json({ items: result.rows });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load export requests." });
      }
    }
  );

  /** POST /exports/:id/approve */
  app.post(
    "/exports/:id/approve",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        const exp = await db.query(
          `SELECT * FROM exports WHERE tenant_id=$1 AND id=$2`,
          [req.tenant_id, id]
        );
        if (!exp.rows.length) return res.status(404).json({ error: "Export not found." });
        if (exp.rows[0].status !== "pending") return res.status(409).json({ error: `Export is already ${exp.rows[0].status}.` });

        const result = await db.query(
          `UPDATE exports
              SET status = 'approved', approved_by_user_id=$2, approved_at=NOW()
            WHERE id=$1
            RETURNING *`,
          [id, req.user_id]
        );

        // Emit to export worker queue
        await db.query(
          `INSERT INTO export_worker_queue (export_id, queued_at) VALUES ($1, NOW())
           ON CONFLICT DO NOTHING`,
          [id]
        ).catch(() => {});

        await db.query(
          `INSERT INTO audit_log (tenant_id, event_id, action_type, actor_id, target_id, result)
           VALUES ($1,$2,'export_approved',$3,$4,'success')`,
          [req.tenant_id, exp.rows[0].event_id, req.user_id, id]
        ).catch(() => {});

        return res.json(result.rows[0]);
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to approve export." });
      }
    }
  );

  /** POST /exports/:id/reject */
  app.post(
    "/exports/:id/reject",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      const { reason } = req.body;
      try {
        const exp = await db.query(
          `SELECT * FROM exports WHERE tenant_id=$1 AND id=$2`,
          [req.tenant_id, id]
        );
        if (!exp.rows.length) return res.status(404).json({ error: "Export not found." });
        if (exp.rows[0].status !== "pending") return res.status(409).json({ error: `Export is already ${exp.rows[0].status}.` });

        const result = await db.query(
          `UPDATE exports
              SET status='rejected', rejection_reason=$2, rejected_by_user_id=$3, rejected_at=NOW()
            WHERE id=$1
            RETURNING *`,
          [id, reason || null, req.user_id]
        );

        await db.query(
          `INSERT INTO audit_log (tenant_id, event_id, action_type, actor_id, target_id, payload, result)
           VALUES ($1,$2,'export_rejected',$3,$4,$5,'success')`,
          [req.tenant_id, exp.rows[0].event_id, req.user_id, id, JSON.stringify({ reason })]
        ).catch(() => {});

        return res.json(result.rows[0]);
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to reject export." });
      }
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * AU-01  AUDIT LOG
   * ───────────────────────────────────────────────────────────── */

  /** GET /organizer/events/:eventId/audit-log */
  app.get(
    "/organizer/events/:eventId/audit-log",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const actionType = req.query.action_type || null;

      try {
        const whereExtra = actionType ? " AND action_type = $4" : "";
        const binds = actionType
          ? [req.tenant_id, eventId, limit, actionType, offset]
          : [req.tenant_id, eventId, limit, offset];

        const offsetParam = actionType ? "$5" : "$4";

        const result = await db.query(
          `SELECT id, action_type, actor_id, target_id, payload, result, created_at
             FROM audit_log
            WHERE tenant_id = $1
              AND event_id  = $2
              ${whereExtra}
            ORDER BY created_at DESC
            LIMIT $3 OFFSET ${offsetParam}`,
          binds
        );

        const countResult = await db.query(
          `SELECT COUNT(*) AS total FROM audit_log
            WHERE tenant_id=$1 AND event_id=$2 ${actionType ? "AND action_type=$3" : ""}`,
          actionType ? [req.tenant_id, eventId, actionType] : [req.tenant_id, eventId]
        );

        return res.json({
          items: result.rows,
          total: parseInt(countResult.rows[0].total, 10),
        });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load audit log." });
      }
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * AT-01  ATTENDEE MOBILE ROUTES
   * ───────────────────────────────────────────────────────────── */

  /** GET /attendee/interactions/:id  — landing page context */
  app.get(
    "/attendee/interactions/:id",
    authenticate(["attendee", "device"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        const result = await db.query(
          `SELECT i.*,
                  s.name AS stall_name, e.name AS event_name,
                  b.primary_color, b.welcome_headline, b.welcome_body, b.cta_label,
                  c.vendor_release_allowed, c.sponsor_release_allowed, c.captured_at AS consent_captured_at
             FROM interactions i
             JOIN stalls s ON s.id = i.stall_id
             JOIN events e ON e.id = i.event_id
             LEFT JOIN branding_assets b ON b.event_id = i.event_id AND b.is_active = TRUE
             LEFT JOIN consents c ON c.interaction_id = i.id
            WHERE i.id = $1 AND i.tenant_id = $2`,
          [id, req.tenant_id]
        );
        if (!result.rows.length) return res.status(404).json({ error: "Interaction not found." });
        const row = result.rows[0];
        // Return branding as nested object
        const branding = { primary_color: row.primary_color, welcome_headline: row.welcome_headline, welcome_body: row.welcome_body, cta_label: row.cta_label };
        return res.json({ ...row, branding });
      } catch (err) {
        return res.status(500).json({ error: "Failed to load interaction." });
      }
    }
  );

  /** GET /attendee/vault  — all interactions for this attendee */
  app.get(
    "/attendee/vault",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { event_id } = req.query;
      try {
        const result = await db.query(
          `SELECT i.id, i.tap_type, i.occurred_at, i.stall_id,
                  s.name AS stall_name, e.id AS event_id, e.name AS event_name,
                  c.vendor_release_allowed, c.sponsor_release_allowed, c.captured_at AS consent_captured_at
             FROM interactions i
             JOIN stalls s ON s.id = i.stall_id
             JOIN events e ON e.id = i.event_id
             LEFT JOIN consents c ON c.interaction_id = i.id
            WHERE i.attendee_id = $1
              AND i.tenant_id   = $2
              ${event_id ? "AND i.event_id = $3" : ""}
            ORDER BY i.occurred_at DESC
            LIMIT 100`,
          event_id ? [req.actor_id, req.tenant_id, event_id] : [req.actor_id, req.tenant_id]
        );
        return res.json({ items: result.rows });
      } catch (err) {
        return res.status(500).json({ error: "Failed to load vault." });
      }
    }
  );

  /** POST /consents/capture  — spec §2.2: record timestamp, locale, user-agent */
  app.post(
    "/consents/capture",
    authenticate(["attendee", "device"]),
    requireTenant,
    async (req, res) => {
      const { interaction_id, vendor_release_allowed, sponsor_release_allowed, captured_at, locale, user_agent, event_id } = req.body;
      if (!interaction_id) return res.status(400).json({ error: "interaction_id is required." });

      try {
        const result = await db.query(
          `INSERT INTO consents
             (tenant_id, interaction_id, event_id,
              vendor_release_allowed, sponsor_release_allowed,
              captured_at, locale, user_agent)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (interaction_id)
           DO UPDATE SET
             vendor_release_allowed  = EXCLUDED.vendor_release_allowed,
             sponsor_release_allowed = EXCLUDED.sponsor_release_allowed,
             captured_at             = EXCLUDED.captured_at,
             locale                  = EXCLUDED.locale,
             user_agent              = EXCLUDED.user_agent
           RETURNING *`,
          [
            req.tenant_id, interaction_id, event_id || null,
            !!vendor_release_allowed, !!sponsor_release_allowed,
            captured_at || new Date().toISOString(),
            locale || null, user_agent || null,
          ]
        );

        // Emit consent event for realtime inbox refresh
        await db.query(
          `INSERT INTO consent_events (tenant_id, interaction_id, event_type, vendor_allowed, sponsor_allowed, created_at)
           VALUES ($1,$2,'consent_captured',$3,$4,NOW())`,
          [req.tenant_id, interaction_id, !!vendor_release_allowed, !!sponsor_release_allowed]
        ).catch(() => {});

        return res.status(201).json(result.rows[0]);
      } catch (err) {
        return res.status(500).json({ error: "Failed to capture consent." });
      }
    }
  );

  /** POST /consents/revoke  — per-vendor or per-sponsor revoke */
  app.post(
    "/consents/revoke",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { interaction_id, scope } = req.body; // scope: "vendor" | "sponsor" | "all"
      if (!interaction_id) return res.status(400).json({ error: "interaction_id is required." });
      try {
        const updates = scope === "vendor"
          ? "vendor_release_allowed = FALSE"
          : scope === "sponsor"
          ? "sponsor_release_allowed = FALSE"
          : "vendor_release_allowed = FALSE, sponsor_release_allowed = FALSE";

        await db.query(
          `UPDATE consents SET ${updates}, revoked_at = NOW() WHERE tenant_id=$1 AND interaction_id=$2`,
          [req.tenant_id, interaction_id]
        );

        await db.query(
          `INSERT INTO consent_events (tenant_id, interaction_id, event_type, vendor_allowed, sponsor_allowed, created_at)
           SELECT $1,$2,'consent_revoked',
             CASE WHEN $3='sponsor' THEN vendor_release_allowed ELSE FALSE END,
             CASE WHEN $3='vendor'  THEN sponsor_release_allowed ELSE FALSE END,
             NOW()
           FROM consents WHERE interaction_id=$2`,
          [req.tenant_id, interaction_id, scope || "all"]
        ).catch(() => {});

        return res.json({ revoked: true, scope: scope || "all" });
      } catch (err) {
        return res.status(500).json({ error: "Failed to revoke consent." });
      }
    }
  );

  /** POST /consents/revoke-all  — revoke all consents for an event */
  app.post(
    "/consents/revoke-all",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { event_id } = req.body;
      if (!event_id) return res.status(400).json({ error: "event_id is required." });
      try {
        const result = await db.query(
          `UPDATE consents SET vendor_release_allowed=FALSE, sponsor_release_allowed=FALSE, revoked_at=NOW()
            WHERE tenant_id=$1 AND event_id=$2
            RETURNING id`,
          [req.tenant_id, event_id]
        );
        return res.json({ revoked: true, count: result.rowCount });
      } catch (err) {
        return res.status(500).json({ error: "Failed to revoke all consents." });
      }
    }
  );

  /** GET /attendee/consents  — active consents for the attendee */
  app.get(
    "/attendee/consents",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { event_id } = req.query;
      try {
        const result = await db.query(
          `SELECT c.*, s.name AS stall_name
             FROM consents c
             LEFT JOIN interactions i ON i.id = c.interaction_id
             LEFT JOIN stalls s ON s.id = i.stall_id
            WHERE i.attendee_id = $1 AND c.tenant_id = $2
              ${event_id ? "AND c.event_id = $3" : ""}
              AND c.revoked_at IS NULL
            ORDER BY c.captured_at DESC`,
          event_id ? [req.actor_id, req.tenant_id, event_id] : [req.actor_id, req.tenant_id]
        );
        return res.json({ items: result.rows });
      } catch (err) {
        return res.status(500).json({ error: "Failed to load consents." });
      }
    }
  );

  /** POST /attendee/data-subject-requests  — DSR submit */
  app.post(
    "/attendee/data-subject-requests",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { request_type, event_id } = req.body;
      const valid_types = ["export", "delete", "access", "portability"];
      if (!request_type || !valid_types.includes(request_type))
        return res.status(400).json({ error: `request_type must be one of: ${valid_types.join(", ")}` });

      try {
        const result = await db.query(
          `INSERT INTO data_subject_requests
             (tenant_id, attendee_id, event_id, request_type, status)
           VALUES ($1,$2,$3,$4,'requested')
           RETURNING *`,
          [req.tenant_id, req.actor_id, event_id || null, request_type]
        );
        return res.status(201).json(result.rows[0]);
      } catch (err) {
        return res.status(500).json({ error: "Failed to submit DSR." });
      }
    }
  );

  /** GET /attendee/data-subject-requests  — DSR list for attendee */
  app.get(
    "/attendee/data-subject-requests",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      try {
        const result = await db.query(
          `SELECT * FROM data_subject_requests
            WHERE tenant_id=$1 AND attendee_id=$2
            ORDER BY created_at DESC LIMIT 20`,
          [req.tenant_id, req.actor_id]
        );
        return res.json({ items: result.rows });
      } catch (err) {
        return res.status(500).json({ error: "Failed to load DSRs." });
      }
    }
  );

  /** DELETE /attendee/interactions/:id  — attendee deletes own record */
  app.delete(
    "/attendee/interactions/:id",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        // Verify ownership
        const check = await db.query(
          `SELECT id FROM interactions WHERE id=$1 AND attendee_id=$2 AND tenant_id=$3`,
          [id, req.actor_id, req.tenant_id]
        );
        if (!check.rows.length) return res.status(404).json({ error: "Interaction not found or not owned by you." });

        // Anonymise rather than hard-delete (preserve analytics)
        await db.query(
          `UPDATE interactions SET attendee_id=NULL, local_event_id=NULL WHERE id=$1`,
          [id]
        );
        await db.query(
          `UPDATE consents SET vendor_release_allowed=FALSE, sponsor_release_allowed=FALSE, revoked_at=NOW()
            WHERE interaction_id=$1`,
          [id]
        );
        return res.json({ deleted: true, id });
      } catch (err) {
        return res.status(500).json({ error: "Failed to delete interaction." });
      }
    }
  );

  /** GET /attendee/interactions/:id/export  — attendee self-export */
  app.get(
    "/attendee/interactions/:id/export",
    authenticate(["attendee"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        const check = await db.query(
          `SELECT * FROM interactions WHERE id=$1 AND attendee_id=$2 AND tenant_id=$3`,
          [id, req.actor_id, req.tenant_id]
        );
        if (!check.rows.length) return res.status(404).json({ error: "Interaction not found." });
        // Create a DSR export job
        const dsr = await db.query(
          `INSERT INTO data_subject_requests
             (tenant_id, attendee_id, event_id, request_type, status)
           VALUES ($1,$2,$3,'export','requested')
           RETURNING id`,
          [req.tenant_id, req.actor_id, check.rows[0].event_id]
        );
        return res.json({ requested: true, dsr_id: dsr.rows[0].id, message: "Export queued — you will receive it by email." });
      } catch (err) {
        return res.status(500).json({ error: "Failed to request export." });
      }
    }
  );

/* ──────────────────────────────────────────────────────────────
 * END OF BATCH 3 PATCH
 * ────────────────────────────────────────────────────────────── */
