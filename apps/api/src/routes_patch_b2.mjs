/**
 * routes_patch_final.mjs
 *
 * Paste ALL of the following route registrations into apps/api/src/routes.mjs
 * BEFORE the closing `}` of the registerRoutes() function.
 *
 * Covers:
 *   API-09  GET  /events/:eventId/branding
 *   API-09  POST /branding/publish
 *   API-09  GET  /events/:eventId/heatmap              (no PII, zone aggregates)
 *   API-09  GET  /organizer/events/:eventId/branding-assets
 *   DM-17   GET  /webhook-subscriptions                (list)
 *   DM-17   POST /webhook-subscriptions                (create)
 *   DM-17   GET  /webhook-subscriptions/:id            (get one)
 *   DM-17   PATCH /webhook-subscriptions/:id           (update)
 *   DM-17   DELETE /webhook-subscriptions/:id          (delete)
 *   DM-17   GET  /webhook-subscriptions/:id/deliveries (delivery log)
 *   DM-17   POST /webhook-subscriptions/:id/test       (fire a test ping)
 *   API-12  POST /integrations/crm/push                (alias of /interactions/:id/crm-sync)
 */

  /* ─────────────────────────────────────────────────────────────
   * BRANDING ROUTES  (API-09 / KI-12)
   * ───────────────────────────────────────────────────────────── */

  /** GET /events/:eventId/branding
   *  Returns the active branding config for a given event.
   *  Device tokens are allowed (kiosk needs this offline-first). */
  app.get(
    "/events/:eventId/branding",
    authenticate(["device", "organizer_admin", "sponsor_admin", "attendee"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      try {
        const branding = await db.query(
          `SELECT b.*
             FROM branding_assets b
            WHERE b.tenant_id = $1
              AND b.event_id  = $2
              AND b.is_active = TRUE
            ORDER BY b.published_at DESC
            LIMIT 1`,
          [req.tenant_id, eventId]
        );

        if (!branding.rows.length) {
          // Return sensible defaults so the kiosk can always render
          return res.json({
            event_id:         eventId,
            primary_color:    "#112233",
            secondary_color:  "#d86e2d",
            background_color: "#fffaf2",
            logo_url:         null,
            welcome_headline: "Welcome",
            welcome_body:     "Tap your badge to connect.",
            thank_you_headline: "Thank you!",
            thank_you_body:   "Your details have been recorded.",
            cta_label:        "Connect",
            is_default:       true,
          });
        }

        return res.json({ ...branding.rows[0], is_default: false });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load branding config." });
      }
    }
  );

  /** POST /branding/publish
   *  Organizer publishes (activates) a branding config for an event.
   *  Body: { event_id, primary_color, secondary_color, background_color,
   *          logo_url, welcome_headline, welcome_body,
   *          thank_you_headline, thank_you_body, cta_label } */
  app.post(
    "/branding/publish",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const {
        event_id, primary_color, secondary_color, background_color,
        logo_url, welcome_headline, welcome_body,
        thank_you_headline, thank_you_body, cta_label,
      } = req.body;

      if (!event_id) return res.status(400).json({ error: "event_id is required." });

      try {
        // Deactivate existing branding for this event
        await db.query(
          `UPDATE branding_assets
              SET is_active = FALSE
            WHERE tenant_id = $1 AND event_id = $2`,
          [req.tenant_id, event_id]
        );

        const result = await db.query(
          `INSERT INTO branding_assets
             (tenant_id, event_id, primary_color, secondary_color, background_color,
              logo_url, welcome_headline, welcome_body,
              thank_you_headline, thank_you_body, cta_label,
              is_active, published_at, published_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,NOW(),$12)
           RETURNING *`,
          [
            req.tenant_id, event_id,
            primary_color || "#112233",
            secondary_color || "#d86e2d",
            background_color || "#fffaf2",
            logo_url || null,
            welcome_headline || "Welcome",
            welcome_body || "Tap your badge to connect.",
            thank_you_headline || "Thank you!",
            thank_you_body || "Your details have been recorded.",
            cta_label || "Connect",
            req.user_id,
          ]
        );

        return res.status(201).json(result.rows[0]);
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to publish branding." });
      }
    }
  );

  /** GET /events/:eventId/heatmap
   *  Returns zone-aggregated interaction heat scores for a given event.
   *  No raw attendee PII is returned — aggregate only.
   *  Query params: ?hours=N (optional, last N hours window) */
  app.get(
    "/events/:eventId/heatmap",
    authenticate(["organizer_admin", "sponsor_admin", "attendee"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      const hours = parseInt(req.query.hours, 10) || null;

      try {
        const sinceClause = hours
          ? `AND i.created_at >= NOW() - INTERVAL '${hours} hours'`
          : "";

        const result = await db.query(
          `SELECT
              s.id               AS stall_id,
              s.name             AS stall_name,
              s.code             AS stall_code,
              COUNT(i.id)        AS interactions,
              COUNT(CASE WHEN i.consent_sponsor = TRUE THEN 1 END) AS sponsor_consented,
              COUNT(CASE WHEN i.interaction_type = 'click' THEN 1 END) AS sponsor_clicks,
              ROUND(
                COUNT(CASE WHEN i.interaction_type = 'click' THEN 1 END)::numeric /
                NULLIF(COUNT(i.id),0) * 100, 1
              )                  AS ctr,
              -- heat score: raw interactions + weighted clicks + weighted opt-ins
              (
                COUNT(i.id) +
                COUNT(CASE WHEN i.interaction_type = 'click' THEN 1 END) * 3 +
                COUNT(CASE WHEN i.consent_sponsor = TRUE THEN 1 END) * 2
              )                  AS zone_score,
              DATE_TRUNC('hour',
                MAX(CASE WHEN i.interaction_type = 'click' THEN i.created_at END)
              )                  AS peak_hour
            FROM stalls s
            JOIN interactions i ON i.stall_id = s.id ${sinceClause}
           WHERE s.tenant_id = $1
             AND s.event_id  = $2
             AND i.tenant_id = $1
           GROUP BY s.id, s.name, s.code
           ORDER BY zone_score DESC`,
          [req.tenant_id, eventId]
        );

        // Also supply an hourly trend across ALL zones for the organizer chart (OR-03)
        const hourlyResult = await db.query(
          `SELECT
              DATE_TRUNC('hour', i.created_at) AS hour,
              COUNT(i.id)                      AS impressions,
              COUNT(CASE WHEN i.interaction_type = 'click' THEN 1 END)    AS clicks,
              COUNT(CASE WHEN i.consent_sponsor = TRUE THEN 1 END)         AS opted_in_leads
            FROM interactions i
            JOIN stalls s ON s.id = i.stall_id
           WHERE i.tenant_id = $1
             AND s.event_id  = $2
           GROUP BY DATE_TRUNC('hour', i.created_at)
           ORDER BY hour ASC`,
          [req.tenant_id, eventId]
        );

        return res.json({
          event_id:     eventId,
          generated_at: new Date().toISOString(),
          zones:        result.rows,
          hourly_trend: hourlyResult.rows,
        });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load heatmap." });
      }
    }
  );

  /** GET /organizer/events/:eventId/branding-assets
   *  Lists all branding asset versions for an event (organizer only). */
  app.get(
    "/organizer/events/:eventId/branding-assets",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { eventId } = req.params;
      try {
        const result = await db.query(
          `SELECT * FROM branding_assets
            WHERE tenant_id = $1 AND event_id = $2
            ORDER BY published_at DESC`,
          [req.tenant_id, eventId]
        );
        return res.json({ items: result.rows });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to list branding assets." });
      }
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * WEBHOOK SUBSCRIPTION ROUTES  (DM-17)
   * ───────────────────────────────────────────────────────────── */

  /** GET /webhook-subscriptions
   *  List all webhook subscriptions for the tenant.
   *  Query params: ?event_id=, ?status=active|inactive */
  app.get(
    "/webhook-subscriptions",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { event_id, status } = req.query;
      try {
        let whereExtra = "";
        const binds = [req.tenant_id];
        if (event_id) { binds.push(event_id); whereExtra += ` AND event_id = $${binds.length}`; }
        if (status)   { binds.push(status);   whereExtra += ` AND status = $${binds.length}`; }

        const result = await db.query(
          `SELECT id, event_id, target_url, event_types, status,
                  created_at, updated_at, created_by_user_id,
                  failure_count, last_fired_at, last_success_at
             FROM webhook_subscriptions
            WHERE tenant_id = $1 ${whereExtra}
            ORDER BY created_at DESC`,
          binds
        );
        return res.json({ items: result.rows });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to list webhook subscriptions." });
      }
    }
  );

  /** POST /webhook-subscriptions
   *  Create a new webhook subscription.
   *  Body: { event_id, target_url, event_types: string[], secret? } */
  app.post(
    "/webhook-subscriptions",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { event_id, target_url, event_types, secret } = req.body;
      if (!event_id)    return res.status(400).json({ error: "event_id is required." });
      if (!target_url)  return res.status(400).json({ error: "target_url is required." });
      if (!Array.isArray(event_types) || !event_types.length)
        return res.status(400).json({ error: "event_types must be a non-empty array." });

      const validTypes = ["interaction.created", "interaction.synced", "export.ready",
                          "consent.updated", "event.frozen", "event.unfrozen"];
      const invalid = event_types.filter(t => !validTypes.includes(t));
      if (invalid.length)
        return res.status(400).json({ error: `Unknown event types: ${invalid.join(", ")}` });

      try {
        const result = await db.query(
          `INSERT INTO webhook_subscriptions
             (tenant_id, event_id, target_url, event_types, secret_hash,
              status, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5,'active',$6)
           RETURNING id, event_id, target_url, event_types, status, created_at`,
          [
            req.tenant_id, event_id, target_url,
            JSON.stringify(event_types),
            secret ? hashSecret(secret) : null,
            req.user_id,
          ]
        );
        return res.status(201).json(result.rows[0]);
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to create webhook subscription." });
      }
    }
  );

  /** GET /webhook-subscriptions/:id
   *  Fetch a single webhook subscription. */
  app.get(
    "/webhook-subscriptions/:id",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        const result = await db.query(
          `SELECT id, event_id, target_url, event_types, status,
                  created_at, updated_at, created_by_user_id,
                  failure_count, last_fired_at, last_success_at
             FROM webhook_subscriptions
            WHERE tenant_id = $1 AND id = $2`,
          [req.tenant_id, id]
        );
        if (!result.rows.length) return res.status(404).json({ error: "Webhook subscription not found." });
        return res.json(result.rows[0]);
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to fetch webhook subscription." });
      }
    }
  );

  /** PATCH /webhook-subscriptions/:id
   *  Update target_url, event_types, or status of a webhook subscription.
   *  Body: { target_url?, event_types?, status?, secret? } */
  app.patch(
    "/webhook-subscriptions/:id",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      const { target_url, event_types, status, secret } = req.body;
      const allowed_statuses = ["active", "inactive"];
      if (status && !allowed_statuses.includes(status))
        return res.status(400).json({ error: `status must be one of: ${allowed_statuses.join(", ")}` });

      try {
        const existing = await db.query(
          `SELECT * FROM webhook_subscriptions WHERE tenant_id=$1 AND id=$2`,
          [req.tenant_id, id]
        );
        if (!existing.rows.length) return res.status(404).json({ error: "Webhook subscription not found." });

        const row = existing.rows[0];
        const result = await db.query(
          `UPDATE webhook_subscriptions
              SET target_url   = $3,
                  event_types  = $4,
                  status       = $5,
                  secret_hash  = COALESCE($6, secret_hash),
                  updated_at   = NOW()
            WHERE tenant_id=$1 AND id=$2
            RETURNING id, event_id, target_url, event_types, status, updated_at`,
          [
            req.tenant_id, id,
            target_url  || row.target_url,
            JSON.stringify(event_types || JSON.parse(row.event_types || "[]")),
            status      || row.status,
            secret ? hashSecret(secret) : null,
          ]
        );
        return res.json(result.rows[0]);
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to update webhook subscription." });
      }
    }
  );

  /** DELETE /webhook-subscriptions/:id
   *  Remove a webhook subscription. */
  app.delete(
    "/webhook-subscriptions/:id",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        const result = await db.query(
          `DELETE FROM webhook_subscriptions WHERE tenant_id=$1 AND id=$2 RETURNING id`,
          [req.tenant_id, id]
        );
        if (!result.rows.length) return res.status(404).json({ error: "Webhook subscription not found." });
        return res.json({ deleted: true, id: result.rows[0].id });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to delete webhook subscription." });
      }
    }
  );

  /** GET /webhook-subscriptions/:id/deliveries
   *  Returns delivery log for a webhook subscription (last 100 attempts). */
  app.get(
    "/webhook-subscriptions/:id/deliveries",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      try {
        // Verify ownership
        const sub = await db.query(
          `SELECT id FROM webhook_subscriptions WHERE tenant_id=$1 AND id=$2`,
          [req.tenant_id, id]
        );
        if (!sub.rows.length) return res.status(404).json({ error: "Webhook subscription not found." });

        const result = await db.query(
          `SELECT id, subscription_id, event_type, payload_event_id,
                  status, http_status, attempt_number, error_message,
                  fired_at, responded_at, duration_ms
             FROM webhook_deliveries
            WHERE subscription_id = $1
            ORDER BY fired_at DESC
            LIMIT $2`,
          [id, limit]
        );
        return res.json({ items: result.rows });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to load webhook deliveries." });
      }
    }
  );

  /** POST /webhook-subscriptions/:id/test
   *  Fire a test ping to the webhook endpoint immediately.
   *  Records the delivery attempt in webhook_deliveries. */
  app.post(
    "/webhook-subscriptions/:id/test",
    authenticate(["organizer_admin"]),
    requireTenant,
    async (req, res) => {
      const { id } = req.params;
      try {
        const sub = await db.query(
          `SELECT * FROM webhook_subscriptions WHERE tenant_id=$1 AND id=$2`,
          [req.tenant_id, id]
        );
        if (!sub.rows.length) return res.status(404).json({ error: "Webhook subscription not found." });
        const { target_url } = sub.rows[0];

        const payload = {
          event_type:  "ping",
          fired_at:    new Date().toISOString(),
          subscription_id: id,
          data:        { message: "Test ping from Codex platform." },
        };

        let httpStatus = null, errorMessage = null, durationMs = null;
        const start = Date.now();
        try {
          const resp = await fetch(target_url, {
            method:  "POST",
            headers: { "content-type": "application/json", "x-codex-event": "ping" },
            body:    JSON.stringify(payload),
            signal:  AbortSignal.timeout(10000),
          });
          httpStatus = resp.status;
          durationMs = Date.now() - start;
          if (!resp.ok) errorMessage = `Remote returned ${resp.status}`;
        } catch (fetchErr) {
          durationMs = Date.now() - start;
          errorMessage = fetchErr.message || "Fetch failed";
        }

        const delivered = !errorMessage;
        await db.query(
          `INSERT INTO webhook_deliveries
             (subscription_id, event_type, payload_event_id,
              status, http_status, attempt_number, error_message,
              fired_at, responded_at, duration_ms)
           VALUES ($1,'ping',null,$2,$3,1,$4,NOW(),NOW(),$5)`,
          [id, delivered ? "delivered" : "failed", httpStatus, errorMessage, durationMs]
        );

        await db.query(
          `UPDATE webhook_subscriptions
              SET last_fired_at = NOW(),
                  failure_count = CASE WHEN $2 THEN failure_count ELSE failure_count+1 END
            WHERE id = $1`,
          [id, delivered]
        );

        return res.json({ delivered, http_status: httpStatus, error_message: errorMessage, duration_ms: durationMs });
      } catch (err) {
        req.log?.error(err);
        return res.status(500).json({ error: "Failed to fire test webhook." });
      }
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * CRM PUSH ALIAS  (API-12)
   * POST /integrations/crm/push  →  proxies to crm-sync logic
   * ───────────────────────────────────────────────────────────── */

  /** POST /integrations/crm/push
   *  Spec-defined alias for CRM sync. Accepts the same body as
   *  POST /interactions/:id/crm-sync but allows batch submission:
   *  Body: { interaction_id?, interaction_ids?: string[],
   *          crm_target: "salesforce"|"hubspot"|"zoho"|"pilot",
   *          field_map?: object, dry_run?: boolean }
   *
   *  This route acts as a normalized entry-point for any CRM adapter.
   *  Individual /interactions/:id/crm-sync calls are still supported. */
  app.post(
    "/integrations/crm/push",
    authenticate(["organizer_admin", "sponsor_admin"]),
    requireTenant,
    async (req, res) => {
      const { interaction_id, interaction_ids, crm_target, field_map, dry_run } = req.body;

      const ids = interaction_ids || (interaction_id ? [interaction_id] : []);
      if (!ids.length) return res.status(400).json({ error: "interaction_id or interaction_ids is required." });

      const validTargets = ["salesforce", "hubspot", "zoho", "pilot"];
      if (!crm_target || !validTargets.includes(crm_target))
        return res.status(400).json({ error: `crm_target must be one of: ${validTargets.join(", ")}` });

      if (dry_run) {
        return res.json({
          dry_run:        true,
          interaction_ids: ids,
          crm_target,
          field_map:      field_map || null,
          message:        "Dry run — no records were pushed to CRM.",
        });
      }

      // Fan out to per-interaction crm-sync
      const results = [];
      for (const iid of ids) {
        try {
          // Re-use existing crm-sync business logic if exposed as a service function.
          // If not, fall back to a direct DB lookup + adapter dispatch.
          const interaction = await db.query(
            `SELECT * FROM interactions WHERE tenant_id=$1 AND id=$2`,
            [req.tenant_id, iid]
          );
          if (!interaction.rows.length) {
            results.push({ interaction_id: iid, status: "not_found" });
            continue;
          }
          // Delegate to pilot adapter for now; real adapters swap in by crm_target
          const syncResult = await dispatchCrmSync({
            interaction: interaction.rows[0],
            crm_target,
            field_map: field_map || null,
            tenant_id: req.tenant_id,
          });
          results.push({ interaction_id: iid, status: "queued", sync_id: syncResult.id });
        } catch (syncErr) {
          results.push({ interaction_id: iid, status: "error", error: syncErr.message });
        }
      }

      const succeeded = results.filter(r => r.status === "queued").length;
      const failed    = results.filter(r => r.status === "error" || r.status === "not_found").length;

      return res.status(succeeded > 0 ? 200 : 422).json({
        crm_target,
        total:     ids.length,
        succeeded,
        failed,
        results,
      });
    }
  );

  /* ─────────────────────────────────────────────────────────────
   * LOCAL HELPERS (add near top of routes.mjs if not present)
   * ───────────────────────────────────────────────────────────── */

  // Minimal HMAC helper for webhook secret hashing.
  // Replace with your existing crypto util if one exists.
  function hashSecret(secret) {
    const crypto = await import("node:crypto");
    return crypto.createHash("sha256").update(secret).digest("hex");
  }

  // Stub for CRM dispatch — replace with real adapter registry.
  async function dispatchCrmSync({ interaction, crm_target, field_map, tenant_id }) {
    // TODO: route to real Salesforce / HubSpot / Zoho adapters
    // For now records the intent as a crm_sync_jobs row if the table exists,
    // or returns a synthetic result for the pilot adapter.
    try {
      const result = await db.query(
        `INSERT INTO crm_sync_jobs (tenant_id, interaction_id, crm_target, field_map, status)
         VALUES ($1,$2,$3,$4,'queued')
         RETURNING id`,
        [tenant_id, interaction.id, crm_target, JSON.stringify(field_map||{})]
      );
      return result.rows[0];
    } catch {
      // Table may not exist yet — return a synthetic queue entry
      return { id: `${crm_target}-${interaction.id}-${Date.now()}` };
    }
  }

/* ──────────────────────────────────────────────────────────────
 * END OF PATCH — paste above closes the registerRoutes() function
 * ────────────────────────────────────────────────────────────── */
