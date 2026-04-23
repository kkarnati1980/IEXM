# Codex Platform — Changelog

## v0.2 — Batch 2 (2026-04-23)

### SP-02 — Zone Heatmap UI (sponsor.html)
- `_renderHeatmap()` renders a zone grid with radial heat overlay per cell
- CSS `--heat` variable drives per-cell intensity (0.04 → 0.85)
- Sort-by filter: heat score / interactions / opted-in leads / CTR
- Falls back to `stall_breakdown` data when heatmap API not available
- Heat legend (cool → hot) colour ramp

### SP-03 — Campaign Funnel Chart (sponsor.html)
- `renderFunnel()` — 5-stage horizontal bar funnel
- Stages: Impressions → Click sessions → Mobile card views → Consent given → Exportable leads
- Per-stage retention % with colour coding (green = good, amber = drop)
- Summary bar: overall conversion rate + CTR

### SP-04 — Audience Insights (sponsor.html)
- `renderAudienceInsights()` + `buildInsightCard()`
- Engagement Intent card (hot/warm/cold/unclassified)
- Consent Profile card (sponsor opt-in / vendor-only / pending)
- Top Zones by Impressions card
- Enrichment-pipeline readiness note

### OR-03 — Hourly Tap Chart (organizer.html)
- `renderHourlyChart()` — stacked bar chart (impressions / clicks / opted-in leads)
- 4-level Y-axis grid with value labels
- Hover tooltip: hour, impressions, clicks, leads, CTR
- View selector: stacked / impressions only / clicks only / leads only

### OR-03 — Visitor Velocity (organizer.html)
- `renderVelocity()` — current taps/hr vs prior hour with delta
- Conversion velocity (leads/hr) KPI
- Peak hour detection (highest impressions + highest consent)
- 24-hr velocity sparkline
- 4 natural-language velocity insights

### DM-17 — Webhook Tables (034_webhook_tables.sql)
- `webhook_subscriptions` table with tenant isolation
- `webhook_deliveries` audit log
- `webhook_event_types` reference table
- Auto-suspend trigger: suspends after 10 consecutive failures
- Rollback block included

### DM-17 — Webhook CRUD Routes (routes_patch_final.mjs)
- `GET    /webhook-subscriptions`
- `POST   /webhook-subscriptions`
- `GET    /webhook-subscriptions/:id`
- `PATCH  /webhook-subscriptions/:id`
- `DELETE /webhook-subscriptions/:id`
- `GET    /webhook-subscriptions/:id/deliveries`
- `POST   /webhook-subscriptions/:id/test`

### API-12 — CRM Push Alias (routes_patch_final.mjs)
- `POST /integrations/crm/push` — batched CRM sync
- Supports: salesforce, hubspot, zoho, pilot
- Dry-run mode
- Fan-out to per-interaction `dispatchCrmSync()`

---

## v0.1 — Batch 1 (2026-04-23)

### RT-07 — IndexedDB Queue Persistence (kiosk.html)
- Full IndexedDB-backed queue with `appendQueueItem()` + `hydrateQueueFromIDB()`
- Survives kiosk reboot — unsynced taps restored on boot

### KI-09 — 2s Reader Debounce (kiosk.html)
- `lastTapAt` + `DEBOUNCE_MS=2000` guard in `simulateTap()`

### RT-04 — 30s Background Sync (kiosk.html)
- `startSyncInterval()` fires `scheduleBackgroundSync()` every 30 seconds

### RT-05 — Exponential Backoff (kiosk.html)
- `min(BACKOFF_BASE_MS * 2^retryCount, 300000ms)` after sync failures

### KI-08 — Auto-reset Timer 15s (kiosk.html)
- `startResetTimer(15)` — was 30s

### KI-11 — 100-item Batch Cap (kiosk.html)
- `allReplayable.slice(0, SYNC_BATCH_MAX)` in `scheduleBackgroundSync()`

### RT-11 — Storage Write Failure Detection (kiosk.html)
- `appendQueueItem()` throws `LOCAL_STORAGE_WRITE_FAILURE` on IDB failure
- Kiosk transitions to exception screen

### KI-12 / API-09 — Branding System (kiosk.html + routes)
- `startBrandingRefresh()` fetches `/events/:id/branding`
- Caches to localStorage, applies colors/text, refreshes every 5 min
- Works offline from cache

### 033_branding_assets.sql
- Migration for `branding_assets` table

---

## v0.0 — Baseline (initial commit)
- Full NFC kiosk platform codebase
- Offline-first kiosk runtime (kiosk.html)
- Organizer ops dashboard (organizer.html)
- Sponsor reporting dashboard (sponsor.html)
- Express API with memory + postgres backends
- RTM coverage: 86% (78 fully built, 18 partial, 16 gaps)
