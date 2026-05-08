# Baseline Master Specification
## Physical-World Interaction Infrastructure Platform

This file is the running history of the Master System Specification across all known builds.
The v1.0 text is the spine. Every change from v1.1 and v1.2 is annotated inline at the point where it applies.

Re-run `/baseline` any time a new build version drops — it will extend this file automatically.

---

## Version History

| Version | Date | Author | Summary |
|---|---|---|---|
| v1.0 | April 2026 | Platform Team | Original pre-build specification — requirements, architecture, design, trust, data, commercial |
| v1.1 | 1 May 2026 | Platform Team | First production build — 18 phases complete; technology stack confirmed; Phase 6 deferred |
| v1.2 | 8 May 2026 | Platform Team | Google Drive/OneDrive integration; MFA; snapshot comparison; unified UI; 79 tables; 438 tests |

---

## Change Summary

| Version | Added | Changed | Removed | Clarified |
|---|---|---|---|---|
| v1.1 | 3 | 6 | 1 | 4 |
| v1.2 | 12 | 5 | 0 | 2 |

---

## Quick Index — All Changes

**v1.1 changes**
- [v1.1-C1] §4 Technology stack confirmed (custom router, scrypt, ZeptoMail, R2)
- [v1.1-C2] §4 Express.js removed — custom router only
- [v1.1-C3] §4 Redis deferred — in-memory session store
- [v1.1-C4] §4 WebSocket deferred — polling used
- [v1.1-C5] §5 Phase 6 (Google Drive/OneDrive) deferred/pending
- [v1.1-C6] §11 UI label changes (3 labels renamed)
- [v1.1-A1] §BUILD 18 build phases all complete
- [v1.1-A2] §STACK 32 HTML screens built
- [v1.1-R1] §12 Launchpad removed for non-admin roles

**v1.2 changes**
- [v1.2-A1] §4 Google Drive/OneDrive integration (Phase 6 complete)
- [v1.2-A2] §4 MFA (email OTP, 10-min expiry)
- [v1.2-A3] §4 Snapshot comparison feature
- [v1.2-A4] §4 Unified UI design system (shared-app.css, IBM Plex Sans, #2D6A9F)
- [v1.2-A5] §7 4 new database tables for Drive storage
- [v1.2-A6] §6 20 new Drive API routes
- [v1.2-A7] §11 AES-256-GCM encryption for OAuth tokens
- [v1.2-A8] §14 Attendee document access page (/docs/:token, no login)
- [v1.2-A9] §14 Demo data: 13 orgs, 18 users, 36 attendees, 60 interactions
- [v1.2-A10] §13 438 tests passing, 0 failing, 24 skipped
- [v1.2-A11] §12 DRIVE_ENCRYPTION_KEY environment variable required
- [v1.2-A12] §12 Google Cloud and Azure AD OAuth app registrations
- [v1.2-C1] §4 Node.js upgraded to v25.8.2
- [v1.2-C2] §7 Total tables expanded from ~75 to 79
- [v1.2-C3] §6 Total API routes expanded to 261+
- [v1.2-C4] §11 All sign-out paths now route to /login (Launchpad fully removed)
- [v1.2-C5] §9 Drive token refresh worker added (runs every 30 min)

---

## 1. Executive Scope and Intent

This platform is an offline-first, kiosk-led, API-first physical-world interaction infrastructure platform.
Its purpose is to capture real-world interactions, convert them into structured and consent-controlled data, activate them through dashboards, CRM, and sponsor reporting, and enforce trust by architecture rather than by assurance.
This document is binding for product, engineering, QA, design, analytics, support, deployment, operations, sales, partner enablement, and governance.

> [v1.2 CLARIFIED §1] The platform now explicitly describes itself as targeting high-throughput events with NFC/QR check-in devices applied to attendee identity management. Core value propositions formalised: real-time NFC/QR tap ingestion, role-based data access, data sovereignty (per-event retention, DSR rights, tenant offboarding), Drive-native document distribution, break-glass access, and full export/reporting with tamper-resistant audit log.

---

## 2. Core Non-Negotiable System Laws

Every tap must be stored locally first.
Every cloud sync must be idempotent by (device_id, local_event_id).
Consent gates all personal-data release.
No bulk attendee database ingestion is allowed as a normal operating mode.
Every query and export must be tenant-scoped and event-scoped.
Sponsors see aggregated analytics by default; raw PII requires sponsor consent and event policy.
Every sensitive action must be auditable.
No AI or third-party enrichment may sit in the critical tap path.
Kiosk interaction must work without internet.
Public leaderboard must never display personal data.

> [v1.2 ADDED §2, no original ancestor] Laws are now formally identified with IDs LAW-01 through LAW-10 and explicitly marked "confirmed implemented in v1.2 production build." Three new laws added beyond the original ten:
> - LAW-08: OAuth tokens for Drive integrations encrypted at rest with AES-256-GCM
> - LAW-09: Device credentials are hashed; raw tokens never stored
> - LAW-10: MFA (email OTP) is available for all user accounts

---

## 3. Actor Model and Responsibility Boundaries

| Role | Responsibilities |
|---|---|
| Attendee | Can interact, consent, review own connections, revoke consent, request export/delete of own data. |
| Vendor Manager | Can view and act on consented leads in own stall scope only, classify Hot/Warm/Cold, add notes, request export if event policy allows, push to CRM if consent and event policy allow. |
| Sponsor User | Can view sponsor-scoped aggregated metrics and sponsor-consented leads only if sponsor PII is enabled by event policy. |
| Organizer Admin | Controls event setup, event-level data policy, export approvals, event analytics, and fleet oversight within own event scope. |
| Platform Admin | Manages infrastructure and masked operations by default; no unrestricted PII browsing; break-glass required for exceptional privileged access. |
| Ops User | Handles device and deployment operations only; no attendee PII access. |
| Device Principal | May fetch config, send heartbeat, report incidents, upload sync batches, and create tap interactions only. |

> [v1.2 ADDED §3] New role added: **public** — Attendee document access page (/docs/:token) — no login required. This is a new actor type introduced for the Drive document access feature.
>
> [v1.2 ADDED §3] **Google Drive Access Control Role**: Vendors can grant access to stall shared folders to specific attendees via a 32-byte hex access token (HMAC-signed). Attendees visit /docs/:token without logging in. The platform validates the token, logs the access, and proxies file listings and viewer URLs from Google Drive or OneDrive.

---

## 4. System Architecture

### 4.1 High-Level Layers

Edge/Kiosk Layer: locked PWA runtime, NFC adapter, local queue, sync engine, branding cache, diagnostics, heartbeat agent, QR fallback.
API Layer: API gateway, auth, tenant resolution, resource resolution, policy enforcement, validation, response masking, audit logging.
Core Services Layer: Event Service, Device Service, Interaction Service, Identity Service, Consent Service, Branding Service, Analytics Service, Integration Service, Notification Service, Realtime Gateway, Agent Orchestrator.
Async Layer: enrichment worker, CRM sync worker, notification worker, sponsor insight and lead-summary workers.
Data Layer: PostgreSQL as source of truth, Redis for cache/pubsub only, object storage for assets/files.
Observability Layer: logs, metrics, alerts, audit trails, dead-letter jobs, incident records.

> [v1.1 CHANGED from §4] **Technology stack confirmed vs. original aspirational choices:**
> - Original spec did not name a specific web framework. v1.1 confirms **no Express.js** — custom router (router.mjs) used throughout for lighter, testable routing.
> - Password hashing: spec assumed bcrypt. v1.1 uses **scrypt** (native Node crypto) — bcrypt unavailable on Railway.
> - Email: spec assumed SMTP. v1.1 uses **ZeptoMail HTTP API** — Railway blocks outbound SMTP port 587.
> - File storage: spec assumed generic object storage. v1.1 uses **Cloudflare R2** (S3-compatible, no egress fees).
> - Realtime: spec assumed Realtime Gateway / WebSocket. v1.1 **defers WebSocket** — polling used throughout. Redis also deferred — in-memory session store functional.
>
> [v1.1 CHANGED from §4] Data Layer note: Redis deferred in v1.1. In-memory store in use. Redis is a pending item.
>
> [v1.2 CHANGED from §4] **Node.js upgraded** to v25.8.2 ESM modules. Original spec did not specify a Node version.
>
> [v1.2 ADDED §4, no original ancestor] **Drive Integration layer added**: Google Drive API (OAuth 2.0 read-only) and Microsoft Graph API (OneDrive) added as external provider integrations. Platform proxies file metadata and viewer URLs; never stores binary file content.

### 4.2 Service Boundaries

| Service | Bounded responsibilities |
|---|---|
| API Gateway | Authentication pass-through, rate limiting, routing, tenant header enforcement |
| Auth Service | OIDC/JWT validation, device auth validation, role mapping, refresh/session handling |
| Event Service | Events, halls, stalls, event data policies, sponsor packages, assignment resolution |
| Device Service | Device registry, assignments, heartbeats, incidents, config responses |
| Interaction Service | Tap ingestion, interaction creation, interaction states, notes, scoring, detail retrieval |
| Identity Service | Attendee and company entities, graph links, profile access |
| Consent Service | Consent capture, revoke, effective consent evaluation, DSR linkage |
| Branding Service | Branding profiles, asset resolution, publish workflow |
| Analytics Service | Impressions, clicks, CTR, heatmaps, leaderboard, event traffic metrics |
| Integration Service | CRM push, webhook routing, wallet generation coordination |
| Notification Service | Email, WhatsApp, SMS, short-link communication |
| Realtime Gateway | Live dashboard channels, leaderboard updates, inbox refresh |
| Agent Orchestrator | Async enrichment, summaries, follow-up drafts, sponsor insights |

> [v1.1 CLARIFIED §4.2] The Notification Service uses ZeptoMail HTTP API rather than SMTP. WhatsApp and SMS are deferred; only email is implemented in v1.1.
>
> [v1.2 ADDED §4.2, no original ancestor] **Drive Token Refresh Worker** added to Async Layer: runs every 30 minutes, refreshes Google/OneDrive OAuth tokens before expiry, marks connection error on failure.

---

## 5. Complete Functional Scope by Screen and Flow

### 5.1 Global UI Rules

Every screen must support loading, empty, and error states.
Every action must provide success or failure feedback.
PII fields must be masked whenever consent and policy do not permit display.
All attendee-facing screens must avoid technical error jargon.
All dashboard screens must reflect scope-limited data only.

> [v1.2 ADDED §5] **Unified design system** applied to all 32 screens: shared-app.css, IBM Plex Sans font throughout, accent color #2D6A9F, light theme. Original spec did not prescribe a design system.

### 5.2 Kiosk Application Screens

| Screen | Authoritative purpose and behavior |
|---|---|
| Boot Screen | Initialize local services, load cached config, attempt device config fetch, verify reader connectivity, show retry if config unavailable. |
| Idle Screen | Default attendee-facing state showing sponsor creative, event logo, tap CTA, QR fallback, local/offline-safe branding. |
| Tap Processing Screen | Immediate feedback after NFC read; generates local_event_id and persists local queue record before any cloud call. |
| Active Interaction Screen | Displays attendee preview or anonymous placeholder plus sponsor panel and optional staff controls. |
| Interaction Exception Screen | Handles unreadable tags, unresolved local preview, duplicate suppression, and safe fallback actions. |
| Diagnostics Screen | Hidden admin-only screen showing device identity, assignment, queue depth, last sync, reader status, logs, force sync, refresh config, restart adapter. |

> [v1.1 ADDED §5.2] Kiosk page shows `CONFIG_ERROR` in browser by design — physical device required.

### 5.3 Attendee Mobile Flow

| Screen | Required behavior |
|---|---|
| Landing Page | Shows event and vendor context, confirms contact exchange, presents save/contact actions. |
| Consent Page | Captures separate vendor-share and sponsor-outreach choices; no pre-ticked options; records timestamp, locale, IP, user agent. |
| Contact Vault | Lists attendee's own connections, brochures, notes, and privacy controls. |
| Contact Detail | Shows own stored connection detail and provides revoke/export/delete actions. |
| Privacy/Unsubscribe | Allows per-vendor revoke, sponsor opt-out, export request, delete request. |

### 5.4 Vendor Dashboard

| Screen | Required behavior |
|---|---|
| Lead Inbox | Chronological, paginated, filterable list with timestamp, attendee, company, title, score, consent status, next action, CRM state. Anonymous masking required when no vendor consent. |
| Lead Detail | Profile, company, enrichment evidence, interaction history, notes, follow-up timeline; hide PII if consent unavailable. |
| Scoring and Notes | Inline Hot/Warm/Cold scoring and note capture. |
| CRM Settings | Connection to Salesforce/HubSpot/Zoho, field mapping, test push, sync rules. |
| Export | Consent-filtered export request only; approval workflow respected. |

> [v1.2 ADDED §5.4, no original ancestor] **Vendor Drive screen added**: connect Google Drive or OneDrive, manage shared folders, issue/revoke attendee access grants. Auto-grant document access on attendee NFC tap.

### 5.5 Sponsor Dashboard

| Screen | Required behavior |
|---|---|
| Overview | Total impressions, total clicks, CTR, opted-in leads, top hour, top zone. |
| Heatmap | Hall plan, hot zones, filters by time/category/cluster, no raw PII. |
| Campaign Performance | Funnel from impression → mobile view → click → consent → exportable lead. |
| Audience Insights | Industry, seniority, geo, company size, intent theme in aggregate. |
| Lead Export | Only sponsor-consented leads and only if event_data_policies.sponsor_pii_enabled = true. |

### 5.6 Organizer Dashboard

| Screen | Required behavior |
|---|---|
| Event Overview | Total interactions, active devices, top stalls, queue depth, sync latency. |
| Fleet Page | Per-device status, hall, stall, battery, signal, queue depth, last heartbeat, app version, incident state. |
| Traffic Analytics | Taps by hour, visitor velocity, booth traffic map, top stalls. |
| Data Control | vendor_exports_enabled, sponsor_pii_enabled, require_export_approval, allow_crm_push, retention_days, allow_cross_event_identity_graph. |
| Export Approval | Pending/approved/rejected export requests and approval actions. |
| Audit Log | Sensitive actions, actor, action, target, timestamp. |

> [v1.1 CHANGED from §5.6] **UI label changes in v1.1:**
> - "IAM Audit" → "Access Change History"
> - "Security Hardening" → retains name but adds warning banner
> - "Access Control" → adds enable/disable toggle

---

## 6. Backend Architecture, APIs, and Middleware

### 6.1 Request Lifecycle Order

1. requestIdMiddleware
2. transportSecurityCheckMiddleware
3. authMiddleware
4. tenantResolutionMiddleware
5. resourceResolutionMiddleware
6. roleScopeMiddleware
7. policyEngineMiddleware
8. validationMiddleware
9. endpoint handler
10. responseMaskingMiddleware
11. auditMiddleware
12. metricsMiddleware

### 6.2 Trust Enforcement Policies

- Tenant isolation: no cross-tenant read or write.
- Event scope restriction: all event-scoped actors limited to their assigned event(s) and stall(s).
- Consent gating: vendor PII requires vendor_release_allowed = true; sponsor PII requires sponsor_release_allowed = true and sponsor_pii_enabled = true.
- Event policy override: event_data_policies can further block export, CRM push, sponsor PII, and cross-event graph access.
- No bulk attendee ingestion or export: there is no raw event attendee export endpoint.
- Internal restriction: ops users never receive attendee PII; platform admins default to masked access; break-glass required for exceptional access.
- Async boundary: enrichment and AI helpers must never delay /interactions/tap.

### 6.3 Core API Surface (v1.0 — original)

| Endpoint | Binding behavior |
|---|---|
| POST /device/heartbeat | Device sends battery, signal, reader status, app version, local_queue_depth, timestamp every 60 seconds. |
| GET /device/config | Returns active event assignment, stall assignment, branding profile and feature flags. |
| POST /device/sync | Uploads queued local tap events in chronological order; partial success allowed; duplicates resolve as success. |
| POST /device/incident | Logs reader/app/power/network incidents. |
| POST /interactions/tap | Creates tap_event and interaction from a device-originated tap without waiting on enrichment. |
| GET /interactions/{id} | Scope-limited interaction detail with masking obligations applied. |
| POST /interactions/{id}/classify | Sets Hot/Warm/Cold lead score. |
| POST /interactions/{id}/note | Creates interaction note. |
| GET /stalls/{id}/leads | Consent-filtered lead inbox for vendor or organizer. |
| POST /consents/capture | Creates or updates effective consent state and consent event history. |
| POST /consents/revoke | Revokes vendor and/or sponsor release rights prospectively. |
| GET /events/{id}/branding | Returns branding profile for kiosks and event-scoped UIs. |
| POST /branding/publish | Publishes updated branding to fleet. |
| GET /sponsors/{id}/metrics | Sponsor-scoped overview metrics, never raw PII by default. |
| GET /events/{id}/heatmap | Aggregated event heatmap data. |
| GET /events/{id}/leaderboard | Leaderboard dataset with no personal data. |
| POST /integrations/crm/push | Queues CRM push only if consent and event policy allow. |
| POST /exports/request | Creates export request for approval/generation workflow. |
| POST /exports/{id}/approve | Organizer approves pending export. |
| GET /exports/{id}/download | Serves signed expiring export file URL when completed. |

> [v1.1 CHANGED from §6.3] **Route paths confirmed in implementation** differ slightly from spec. Implemented paths include /auth/login, /auth/logout, /devices/register, /devices/auth, /devices/:id/heartbeat, /devices/:id/config, /devices/:id/incidents, /iot/runs. Rate limiting added: auth (20/window), public (20), sensitive (30), admin (15).
>
> [v1.2 ADDED §6.3, no original ancestor] **20 new Drive API routes** added for Phase 6:
>
> | Method | Path | Description |
> |---|---|---|
> | GET | /stalls/:stallId/drive/connect/google | Initiate Google Drive OAuth |
> | GET | /stalls/:stallId/drive/connect/onedrive | Initiate OneDrive OAuth |
> | GET | /auth/drive/google/callback | Handle Google OAuth callback |
> | GET | /auth/drive/onedrive/callback | Handle OneDrive OAuth callback |
> | GET | /stalls/:stallId/drive/connection | Get drive connection status |
> | DELETE | /stalls/:stallId/drive/disconnect | Revoke drive connection |
> | GET | /stalls/:stallId/drive/folders | List Drive root folders |
> | GET | /stalls/:stallId/drive/shared-folders | List configured shared folders |
> | POST | /stalls/:stallId/drive/shared-folders | Add shared folder |
> | PATCH | /stalls/:stallId/drive/shared-folders/:folderId | Update shared folder |
> | DELETE | /stalls/:stallId/drive/shared-folders/:folderId | Remove shared folder |
> | GET | /stalls/:stallId/drive/access-grants | List access grants |
> | POST | /stalls/:stallId/drive/access-grants | Create access grant |
> | POST | /stalls/:stallId/drive/access-grants/:grantId/revoke | Revoke grant |
> | POST | /stalls/:stallId/drive/access-grants/:grantId/suspend | Suspend grant |
> | POST | /stalls/:stallId/drive/access-grants/:grantId/restore | Restore grant |
> | GET | /docs/:accessToken/folders | List folders (no login; token-auth) |
> | GET | /docs/:accessToken/folders/:folderId/files | List files in folder |
> | GET | /docs/:accessToken/folders/:folderId/files/:fileId/view | Get viewer URL |
> | GET | /docs/:accessToken/folders/:folderId/files/:fileId/download | Get download URL |
>
> [v1.2 ADDED §6.3] **MFA routes added:**
> - POST /auth/send-otp — sends 6-digit OTP via email (10-min expiry)
> - POST /auth/verify-otp — verifies OTP; returns JWT if valid
>
> [v1.2 CHANGED from §6.3] **Total API routes: 261+** (original spec did not number routes).

---

## 7. Data Model and Persistence Contract

### 7.1 Core Tables (v1.0)

| Table/domain | Purpose |
|---|---|
| tenants | Top-level isolation boundary for all data |
| organizations | Organizer, sponsor, vendor, or internal organization |
| users / roles / user_role_assignments | Human users and role model |
| events / halls / stalls | Event topology |
| devices / nfc_readers / device_assignments / device_heartbeats / device_incidents | Fleet inventory, health, and assignment |
| attendees / attendee_profiles / companies / person_company_links | Identity and profile entities |
| tap_events | Raw deduplicated cloud-ingested tap record; unique by (device_id, local_event_id) |
| interactions | Business interaction lifecycle record |
| interaction_notes | User-authored notes |
| consents / consent_events | Effective consent state and immutable consent history |
| enrichment_requests / enrichment_results | Async enrichment pipeline |
| sponsor_packages / branding_profiles | Commercial sponsorship and branding |
| banner_impressions / banner_clicks / brochure_views | Analytics events |
| crm_connections / crm_sync_jobs | Integration state and CRM pushes |
| audit_logs | Sensitive action audit trail |

> [v1.1 CHANGED from §7.1] **Total tables in v1.1: ~75.** Implementation adds tables beyond the original spec: api_clients, device_credentials, stalls, sponsor_packages, event_data_policies, attendee_profiles, tap_events, consents, consent_events, interaction_notes, lead_scores, leaderboard_snapshots, short_links, devices, device_assignments, device_heartbeats, device_incidents, iot_integration_runs, iot_sync_checkpoints, notifications, notification_attempts, notification_receipts, followup_messages, audit_log, privacy_audit_log, pentest_findings, final_launch_approvals, commercial_approvals, pilot_signoff_approvals, pilot_dry_run_records, compliance_runs, schema_migrations, export_requests, export_worker_queue, data_subject_requests, break_glass_access, tenant_offboarding_jobs, report_snapshots, event_report_snapshots, downstream_deletion_records, crm_connections, crm_sync_jobs, crm_sync_records, commercial_partners, commercial_deals, communication_channel_consents, communication_suppressions, wallet_passes, webhook_subscriptions, webhook_event_types, webhook_deliveries, branding_assets.
>
> [v1.2 ADDED §7.1] **4 new tables** for Drive storage (new in v1.2, no original ancestor):
>
> | Table | Purpose |
> |---|---|
> | stall_drive_connections | One connection per stall; provider, folder, encrypted tokens, status |
> | stall_shared_folders | Folders shared from a connection; multiple per connection |
> | stall_folder_access | Access grants linking attendees to shared folders; 32-byte token |
> | stall_folder_access_log | Immutable log of every document access event |
>
> [v1.2 CHANGED from §7.1] **Total tables: 79** (v1.1 had ~75).

### 7.2 Clause 20 Additions — Fully In Scope

| Addition | Authoritative scope |
|---|---|
| event_data_policies | Event-level data governance switches; mandatory |
| export_requests | Approval and generation lifecycle for exports; mandatory |
| break_glass_access | Privileged emergency access tracking; mandatory |
| tap_events.created_at | Cloud insert timestamp for sync latency; mandatory |
| leaderboard_snapshots | Historical leaderboard state; required when history/reporting needed |
| notifications | Logical outbound messages; required for full notification stack |
| notification_attempts | Provider-level send attempts; required for full notification stack |
| short_links | Signed/expiring tokenized links; required for attendee sessions/exports/wallet |
| wallet_passes | Wallet artifact tracking; required if wallet output is supported |
| data_subject_requests | Persisted export/delete privacy workflow; required if DSR workflow is supported |
| branding_assets | Versioned remote asset registry; required for managed branding publish |
| webhook_subscriptions | Outbound webhook registrations; required if webhooks are supported |
| webhook_deliveries | Webhook delivery history; required if webhooks are supported |
| interactions.captured_by_user_id | Strongly recommended for staff-specific performance |
| tap_events.cloud_received_at | Strongly recommended explicit receipt timestamp |
| followup_messages | Strongly recommended for detailed outbound response analytics |

### 7.3 Event Data Policies — Exact Fields

| Field | Meaning |
|---|---|
| vendor_exports_enabled | Boolean; if false, vendors cannot export even with consent |
| sponsor_pii_enabled | Boolean; if false, sponsors never receive raw PII |
| require_export_approval | Boolean; if true, export_requests begin in pending state |
| allow_crm_push | Boolean; if false, CRM push blocked for event |
| retention_days | Enum-constrained integer: 30, 60, 90, 180, 365 only |
| allow_cross_event_identity_graph | Boolean; if false, no cross-event graph output |

---

## 8. Authoritative Dashboard Metrics and Calculations

### 8.1 Sponsor Metrics

| Metric | Fixed formula |
|---|---|
| Total Impressions | COUNT(banner_impressions) for sponsor_package_id in selected time range |
| Total Clicks | COUNT(banner_clicks) for sponsor_package_id in selected time range |
| CTR | total_clicks / total_impressions; if impressions = 0 then CTR = 0 |
| Opted-in Leads | COUNT DISTINCT interactions where sponsor_release_allowed = true |
| Top Hall Zone | Highest zone_score where zone_score = impressions_in_zone + clicks_in_zone * 3 |
| Hourly Trend | Time-bucketed impressions and clicks by truncated hour |
| Lead Funnel | impression → mobile view → click → consent → exportable lead |

### 8.2 Organizer Metrics

| Metric | Fixed formula |
|---|---|
| Online Devices | Latest heartbeat within last 2 minutes |
| Offline Devices | Assigned devices with no heartbeat inside 2 minutes |
| Low Battery Devices | Latest heartbeat battery_percent < 20 |
| Average Queue Depth | Average latest local_queue_depth across active devices |
| Average Sync Latency | AVG(cloud_received_at or tap_events.created_at − tap_events.occurred_at) |
| Visitor Velocity | count(interactions in bucket) / bucket_duration |
| Top Stalls | Rank by interactions, tie-break by hot leads, then unique attendees |
| Fleet Health | Online/Warning/Critical by heartbeat, battery, queue depth, incidents |

### 8.3 Vendor Metrics

| Metric | Fixed formula |
|---|---|
| Total Taps | COUNT interactions in stall scope and selected period |
| Unique Leads | COUNT DISTINCT attendee_id where attendee_id IS NOT NULL |
| Hot Leads | COUNT interactions where lead_score = 'hot' |
| Enriched Leads | COUNT DISTINCT interactions with at least one enrichment_result |
| CRM Pushed | COUNT DISTINCT interactions with crm_sync_jobs.status = 'succeeded' |
| Response Rate | (distinct CRM pushed or followup sent) / distinct vendor-consented leads; if denominator = 0 then 0 |
| Qualification Breakdown | Counts by hot, warm, cold, unscored |
| Hot Lead Capture Ratio | hot_leads / total_interactions |

> [v1.2 ADDED §8, no original ancestor] **Snapshot comparison metric**: multi-select snapshots, side-by-side bar chart data, CSV export. Added as new reporting feature.

---

## 9. Device Runtime and Offline-First Contract

### 9.1 Approved Runtime States

BOOTING, CONFIG_LOADING, CONFIG_ERROR, READER_ERROR, IDLE, OFFLINE_IDLE, TAP_READING, INTERACTION_ACTIVE, INTERACTION_EXCEPTION, SYNCING_BACKGROUND, DIAGNOSTICS, LOCKED_UNASSIGNED

### 9.2 Runtime Rules

- A tap is not valid unless durably written to local queue first.
- The queue must preserve chronological order by queue_sequence_number.
- Sync runs every 30 seconds in normal mode and uses exponential backoff after retryable failures.
- Maximum sync batch size is 100 items.
- Reader debounce window is 2 seconds.
- Active interaction screen auto-resets after 15 seconds, extendable to 20 seconds while staff action continues.
- Heartbeat frequency is 60 seconds.
- Warning thresholds: 2 missed heartbeats, battery < 20%, queue depth > 100.
- Critical thresholds: 5 missed heartbeats, battery < 10%, reader disconnected, local queue write failure, queue depth > 500.
- Reboot recovery must restore cached config and queued unsynced records automatically.

> [v1.2 ADDED §9, no original ancestor] **Drive token refresh worker**: runs every 30 minutes. For each active connection with token_expiry within 10 minutes, calls the provider refresh endpoint and updates access_token and token_expiry. On failure, connection status set to "error" and vendor notified.

### 9.3 Failure Matrix

| Failure scenario | Required behavior |
|---|---|
| No internet before tap | Continue in OFFLINE_IDLE; capture locally; sync later |
| No internet during sync | Partial success allowed; remaining items stay retryable |
| Reader disconnected while idle | Move to READER_ERROR; keep QR visible if config valid |
| Reader disconnected during tap | If local write succeeded, continue; else fallback to exception/QR |
| Local storage write failure | Do not claim success; show failure; log critical error |
| Duplicate replay from sync | Treat backend duplicate-existing as success |
| Enrichment failure | Leave interaction valid with basic profile only |
| CRM provider down | Does not affect tap flow; CRM job fails/retries in cloud |
| App crash | Auto-restart; restore queue and config |
| Power loss | After reboot, restore queue and config; no silent loss of queued records |

---

## 10. Trust Architecture and Enforcement

Organizer-owned event policy determines export, sponsor PII, CRM push, retention, and graph permissions.
No bulk attendee database ingestion is permitted.
Every sensitive action is audited: consent, export, approval, CRM push, policy change, break-glass.
Sponsors are aggregate-first and consent-limited.
Platform admin access is masked by default and requires break-glass for exceptional PII access.
Exports are request-driven, policy-checked, consent-filtered, approval-aware, and signed for expiry.
Event trust controls are visible in organizer UI, not hidden in backend only.

### 10.1 Response Masking Rules

| Actor case | Required masking |
|---|---|
| Vendor without vendor consent | display_name = Anonymous Visitor; company/title/email/phone null; export disabled; CRM push disabled |
| Sponsor default | only aggregate metrics and counts; no raw attendee PII |
| Organizer | event-scoped visibility; downstream sharing still governed by policy |
| Platform admin | masked by default; unmasked only during approved break-glass session |

> [v1.2 CHANGED from §10] **Break-glass access**: dual approval required; auto-expires 4 hours after approval; full audit trail. Audit log is tamper-resistant: REVOKE UPDATE DELETE on audit_logs.

---

## 11. Operations, Deployment, and Support

### 11.1 Approval Gates

| Gate | Required approvers |
|---|---|
| Design Freeze | Founder/Product Owner + System Architect + Engineering Lead |
| Build Complete | Engineering Lead + QA/Validation Owner + System Architect |
| Event Configuration Complete | Organizer Success Owner + Ops Lead + Implementation Owner |
| Go-Live Approval | Field Ops Lead + Organizer Representative + Internal Command Owner |
| Event Close | Organizer Representative + Ops Lead + Account Owner |

### 11.2 Event Deployment Checklist

- Create event, halls, stalls, sponsor packages, organizer users, and event_data_policies.
- Plan devices, spares, chargers, readers, network fallback, and dispatch manifest.
- Approve branding inputs: logos, CTAs, URLs, idle/active messages.
- Load assignments and preload branding cache on every device.
- At venue, verify power, kiosk mode, assignment, 10 rapid NFC taps, QR scan, offline capture, reconnect sync, sponsor branding, and heartbeat visibility.
- Do not go live until all checks pass.

### 11.3 Incident Severity Model

| Severity | Definition |
|---|---|
| P0 | Event-blocking or trust-breaking: taps not captured, data leakage, wrong-stall data, export bypass, cross-tenant leakage |
| P1 | Major degradation: one or more key devices down, queue growth critical, sponsor metrics broken, CRM broken event-wide |
| P2 | Moderate issue: slow dashboard, single kiosk restart needed, non-critical metric mismatch |
| P3 | Minor issue: cosmetic or low-impact behavior |

> [v1.1 REMOVED from §11] **Launchpad page removed** for non-admin roles. All sign-out paths → /login. Vendor, sponsor, ops, and attendee roles no longer route through a launchpad.
>
> [v1.2 CHANGED from §11] **UI label changes confirmed in v1.1, still current in v1.2:**
> - Old: "IAM Audit" → New: "Access Change History"
> - "Security Hardening" retains name + warning banner added
> - "Access Control" adds enable/disable toggle

---

## 12. Commercial, Sales, and Partner Operating Model

Commercial positioning must always be exhibitor ROI + sponsor revenue + measurable engagement, not NFC novelty or AI novelty.
Primary target event classes: B2B expos in real estate, education, pharma/medical, industrial/manufacturing, franchise/business segments with 50–200 stalls and sponsor dependency.
Offer structures: Organizer-paid, Sponsor-funded, Mixed monetization.
Sales pipeline stages are fixed: Lead Added → Contacted → Replied → Call Scheduled → Demo Done → Proposal Sent → Negotiation → Closed Won / Closed Lost.
Every CRM record must always include stage, next action, and next action date.
Partner types: Referrer, Channel Partner, Delivery Ecosystem Partner.
Partner payouts must be tracked, approved, and paid after client payment receipt.

### 12.1 Standard Daily Sales Minimums

| Daily metric | Minimum |
|---|---|
| New leads added | 20 |
| Outreach touches / connections | 20 |
| Follow-ups | 10+ |
| Qualification calls | 2 target |
| Demos | 1 target |

---

## 13. Build Phases

> [v1.1 ADDED §13, no original ancestor] **18 build phases** — all complete as of v1.1:

| Phase | Name | Status in v1.1 | Status in v1.2 |
|---|---|---|---|
| 1 | Database Migrations | Done | Done |
| 2 | Authentication & JWT | Done | Done |
| 3 | Role-Based Access Control | Done | Done |
| 4 | Organizer Module | Done | Done |
| 5 | Vendor Module | Done | Done |
| 6 | Google Drive / OneDrive Storage | **Pending in v1.1** | **Done in v1.2** |
| 7 | Sponsor Module | Done | Done |
| 8 | Attendee Module & Privacy | Done | Done |
| 9 | Ops / Fleet Module | Done | Done |
| 10 | Kiosk Check-in | Done | Done |
| 11 | Analytics & Reporting | Done | Done |
| 12 | MFA Two-Step Verification | Done | Done |
| 13 | Snapshot Comparison | Done | Done |
| 14 | Data Population (seed) | Done | Done |
| 15 | Vendor Export & Stall Metrics | Done | Done |
| 16 | Security Hardening | Done | Done |
| 17 | Access Control Matrix | Done | Done |
| 18 | Browser Testing — All 6 Roles | Done | Done |

---

## 14. Screen Inventory

> [v1.1 ADDED §14, no original ancestor] **32 HTML screens** confirmed built:

| URL Path | File | Purpose |
|---|---|---|
| /login | apps/web/login.html | All roles — email + password + MFA OTP |
| /index | apps/web/index.html | Platform root / landing |
| /select-context | apps/web/select-context.html | Multi-org context selector |
| /account | apps/web/account.html | Account settings (all authed roles) |
| /forgot-password | apps/web/forgot-password.html | Password reset request |
| /reset-password | apps/web/reset-password.html | Password reset form (token) |
| /set-password | apps/web/set-password.html | Invite acceptance / initial set password |
| /s | apps/web/s.html | Short-link redirect handler |
| /kiosk | apps/web/kiosk.html | Kiosk check-in (device-only) |
| /leaderboard | apps/web/leaderboard.html | Public event leaderboard |
| /docs | apps/web/docs.html | Attendee document access (tokenised, no login) |
| /organizer | apps/web/organizer.html | Organizer dashboard |
| /organizer/events | apps/web/organizer/events.html | Event list |
| /organizer/event-detail | apps/web/organizer/event-detail.html | Event detail + stalls |
| /organizer/stall-detail | apps/web/organizer/stall-detail.html | Stall detail + drive docs |
| /organizer/sponsor-package-detail | apps/web/organizer/sponsor-package-detail.html | Sponsor package detail |
| /organizer/team | apps/web/organizer/team.html | Team member management |
| /organizer/team-member | apps/web/organizer/team-member.html | Individual member detail |
| /organizer/data-export | apps/web/organizer/data-export.html | Full data export |
| /organizer/privacy-requests | apps/web/organizer/privacy-requests.html | DSR management |
| /organizer/platform-access-log | apps/web/organizer/platform-access-log.html | Access audit log |
| /vendor | apps/web/vendor.html | Vendor dashboard (leads, drive, metrics) |
| /sponsor | apps/web/sponsor.html | Sponsor analytics dashboard |
| /attendee | apps/web/attendee.html | Attendee privacy portal |
| /attendee/privacy | apps/web/attendee/privacy.html | Attendee privacy detail / DSR |
| /ops/fleet | apps/web/ops/fleet.html | Ops device fleet dashboard |
| /admin | apps/web/admin.html | Platform admin dashboard |
| /admin/tenants | apps/web/admin/tenants.html | Tenant list |
| /admin/tenant-detail | apps/web/admin/tenant-detail.html | Tenant detail |
| /admin/compliance | apps/web/admin/compliance.html | Compliance overview |
| /admin/offboarding | apps/web/admin/offboarding.html | Tenant offboarding |
| /admin/privacy-audit-log | apps/web/admin/privacy-audit-log.html | Privacy audit log |
| /admin/retention | apps/web/admin/retention.html | Retention policy management |
| /admin/status | apps/web/admin/status.html | System status |
| /admin/user-detail | apps/web/admin/user-detail.html | User detail (admin) |

> [v1.2 ADDED §14] `/docs` (attendee document access page — no login required) added as part of Phase 6 Drive integration.

---

## 15. Approval Matrix and Change Control

| Change item | Required approvers |
|---|---|
| New feature | Product Owner + System Architect |
| Schema change | System Architect + Engineering Lead |
| Metric formula change | Product Owner + System Architect |
| Trust policy change | Founder/Product Owner + System Architect |
| Export workflow change | System Architect + Organizer-facing policy owner |
| Live-event hotfix | Engineering Lead + System Architect |
| Free pilot or non-standard discount | Founder/Product Owner |
| Partner payout exception | Founder/Product Owner |

---

## 16. Final Non-Negotiable Master Laws

No event goes live without configuration, reader, offline, sync, heartbeat, and branding validation.
No export occurs outside consent and event data policy.
No production event-critical release happens inside the freeze window without emergency approval.
No one bypasses trust controls to keep an event moving.
No dashboard or report metric may use an undefined or changed formula.
No partner or internal role receives data outside documented scope.
No incident affecting trust or PII is treated as minor.
All policy changes, approvals, exports, and privileged access actions are auditable.
Commercial teams sell ROI and trust, not technical novelty.
Field reliability outranks feature breadth.

---

## Appendix A — Role Permissions and Data Visibility Matrix

| Actor | Allowed actions | Forbidden actions |
|---|---|---|
| Attendee | Own contact vault, revoke consent, request DSR export/delete | Any dashboard, any other user's data, policy changes |
| Vendor Manager | Own stall lead inbox, notes, scoring, CRM push if allowed, export request if allowed | Other stalls, non-consented PII, sponsor analytics, policy changes |
| Sponsor User | Sponsor-scoped metrics, heatmaps, aggregate audience insights, sponsor-consented export if allowed | Vendor inbox, non-consented PII, organizer controls |
| Organizer Admin | Event analytics, fleet, export approvals, event data policy, branding approval | Cross-tenant data, implicit bypass of consent |
| Platform Admin | Infrastructure, masked operational access, tenant config, incidents | Unrestricted PII browsing, raw exports without break-glass |
| Ops User | Fleet diagnostics, assignments, incidents | Attendee PII, exports, sponsor data |
| Device Principal | Config fetch, heartbeat, sync, incident logging, tap creation | Dashboards, exports, metrics reads |

---

## Appendix B — End-to-End Flow Definitions

### B.1 Attendee Phone Tap Flow

1. Kiosk is in IDLE or OFFLINE_IDLE with valid event and stall assignment.
2. NFC reader detects phone/tag input.
3. State changes to TAP_READING.
4. Runtime generates local_event_id and queue_sequence_number.
5. Canonical local event is durably written to local queue before any network action.
6. State changes to INTERACTION_ACTIVE.
7. If online, backend /interactions/tap is called asynchronously.
8. Backend creates tap_event and interaction, returns interaction_id, resolution_status, attendee_preview, branding_payload, and customer_link.
9. Attendee opens mobile landing page through NFC or QR/session link.
10. Attendee selects vendor and sponsor consent choices.
11. Consent capture updates consents table, consent_events history, and interactions.consent_status.
12. Vendor inbox updates in real time with masked or unmasked fields according to effective consent and event policy.

> [v1.2 ADDED §B, no original ancestor] **Attendee Document Access Flow**:
> 1. Vendor connects Google Drive/OneDrive via OAuth.
> 2. Vendor configures shared folders and creates access grant for attendee.
> 3. On NFC tap, platform auto-grants document access and generates a 32-byte hex token.
> 4. Attendee visits /docs/:token (no login required).
> 5. Platform validates token, checks expiry, proxies file listing from Drive provider.
> 6. Every access (browse, view, download) is logged in stall_folder_access_log.

### B.2 Offline Recovery Flow

1. Queued unsynced local events remain in queue_store with sync_status = queued or failed_retryable.
2. When network connectivity returns, sync engine starts automatically or on next sync interval.
3. Queue is replayed strictly in ascending queue_sequence_number order.
4. Backend deduplicates by (device_id, local_event_id).
5. Duplicate items are treated as success and marked locally as synced.
6. Retryable failures are retried with exponential backoff; terminal failures remain visible in diagnostics.

---

## Appendix C — Kiosk State Definitions

| State | Definition |
|---|---|
| BOOTING | Initialize local services, storage, reader adapter, network monitor |
| CONFIG_LOADING | Load cached config, attempt GET /device/config, verify assignment and branding |
| CONFIG_ERROR | No usable config; attendee flow blocked; admin retry only |
| READER_ERROR | Reader unavailable; QR fallback remains if config valid |
| LOCKED_UNASSIGNED | Device not assigned; no attendee-facing interaction |
| IDLE | Default branded state with sponsor creative and QR fallback |
| OFFLINE_IDLE | Same as IDLE but explicit offline status for diagnostics |
| TAP_READING | Immediate NFC processing and local queue write |
| INTERACTION_ACTIVE | Attendee preview/basic interaction state with sponsor panel and timer |
| INTERACTION_EXCEPTION | Fallback handling for invalid read or non-recoverable preview issues |
| SYNCING_BACKGROUND | Concurrent state for queued upload and retry handling |
| DIAGNOSTICS | Hidden support state with operational controls and no destructive queue wipe |

---

## Appendix D — Test Coverage

> [v1.2 ADDED §D, no original ancestor] **438 tests passing | 0 fail | 24 skipped**

| Test File | Coverage Area |
|---|---|
| foundation.test.mjs | Core platform invariants and law enforcement |
| phase2-auth.test.mjs | Authentication, JWT, MFA, password flows |
| phase3-users.test.mjs | User management, RBAC, invitations |
| phase4-events.test.mjs | Events, halls, stalls, sponsor packages |
| phase5-middleware.test.mjs | Middleware, rate limiting, security headers |
| phase6-notifications.test.mjs | Notification dispatch, templates, retry |
| phase7-audit.test.mjs | Audit log, tamper resistance, privacy audit |
| phase8-ui-api.test.mjs | UI API routes, frontend integration |
| phase9-fixes.test.mjs | Regression tests for all identified fixes |
| phase11-routing.test.mjs | Route matching, access control matrix |
| phase12-integration.test.mjs | CRM integration, webhook delivery |
| phase13-integration.test.mjs | Export pipeline, DSR, offboarding |
| phase15-sovereignty.test.mjs | Data sovereignty, retention, purge |
| phase16-workers.test.mjs | Background worker integration |
| phase17-notifications.test.mjs | Advanced notification flows |
| drive-storage.test.mjs | Drive OAuth, token encryption, access grants (v1.2) |
| e2e-full-system.test.mjs | End-to-end system test |

---

## Appendix E — Error Codes

| Error code | Meaning |
|---|---|
| UNAUTHENTICATED | Missing/invalid credentials |
| TENANT_MISMATCH | Principal tenant and resource tenant differ |
| ROLE_FORBIDDEN | Role not eligible for route |
| SCOPE_FORBIDDEN | Actor not scoped to event/stall/resource |
| CONSENT_REQUIRED | Vendor release consent absent |
| SPONSOR_CONSENT_REQUIRED | Sponsor release consent absent |
| EVENT_POLICY_BLOCKED | Event data policy forbids action |
| EXPORT_REQUIRES_APPROVAL | Request accepted but waiting organizer approval |
| VALIDATION_ERROR | Request body or parameter invalid |
| RESOURCE_NOT_FOUND | Requested object not found in caller scope |
| PROVIDER_UNAVAILABLE | Downstream provider temporarily unavailable |
| RATE_LIMITED | Gateway or service rate limit applied |
| TRANSPORT_NOT_SECURE | TLS or trusted secure transport not present |

> [v1.2 ADDED §E] Additional error codes introduced for Drive integration:
> - `not_configured` (503) — Drive OAuth env vars not configured on server
> - `token_error` (502) — Drive OAuth token exchange or refresh failed
> - `network_error` (502) — Drive provider API unreachable
> - `db_permission_error` (500) — PostgreSQL RLS or permission denied (internal)
> - `conflict` (409) — State conflict (e.g., drive connection already active)

---

## Appendix F — Event-Time Checklists

### F.1 Pre-Dispatch Checklist
- Device cleaned, labeled, and serial verified.
- Reader paired and functional.
- Correct app version installed.
- Kiosk mode verified.
- Assignment and branding preloaded.
- Offline queue empty before dispatch.
- Battery health verified.
- Charger, spare cable, and spare reader packed as per manifest.

### F.2 Venue Go-Live Checklist
- Correct stall placement and power confirmed.
- 10 rapid NFC taps successful.
- QR fallback successful.
- Offline tap test successful.
- Reconnect sync test successful.
- Heartbeat visible on organizer dashboard.
- Sponsor branding visible and correct.
- No cross-stall or cross-event data visibility observed.

### F.3 End-of-Event Checklist
- All devices accounted for.
- Unsynced queue count reviewed.
- Open incidents triaged.
- Final analytics sanity checked.
- Report freeze approved or scheduled.
- Retention clock confirmed from policy.

---

## Appendix G — Mandatory Manual Validation Set

- No-internet tap capture and later sync replay.
- Duplicate prevention on repeated upload of same local_event_id.
- Consent capture, revoke, and masking behavior across vendor and sponsor roles.
- Sponsor metrics sanity: impressions not equal clicks not equal leads.
- Reboot recovery with queued unsynced local events present.
- Reader disconnect fallback with QR still available.
- Export request, approval, rejection, completion, and expiry behavior.
- CRM push blocked when consent absent or event policy forbids push.
- Public leaderboard contains no personal data.
- Break-glass request, approval, expiry, and audit trace.

> [v1.2 ADDED §G] Additional validation items for v1.2:
> - Google Drive OAuth connect, folder listing, file viewing (no binary download to server).
> - Attendee document access via /docs/:token with no login.
> - Token expiry enforcement on access grants.
> - AES-256-GCM encrypted token storage in database.
> - MFA OTP flow: send, verify, single-use, 10-minute expiry.
> - Snapshot comparison: multi-select, bar chart data, CSV export.

---

## Appendix H — Production Infrastructure and Environment Variables

> [v1.2 ADDED §H, no original ancestor] Full environment variable list as of v1.2:

| Variable | Purpose |
|---|---|
| DATABASE_URL | PostgreSQL connection string (Railway) |
| USE_POSTGRES | true — enables PostgreSQL repositories |
| BASE_URL | https://codex-api-production-064f.up.railway.app |
| SESSION_SECRET | JWT signing secret (min 32 chars) |
| STORAGE_BACKEND | s3 (Cloudflare R2) |
| S3_BUCKET | R2 bucket name |
| S3_REGION | auto (R2 default) |
| S3_ENDPOINT | R2 account endpoint URL |
| S3_ACCESS_KEY_ID | R2 access key |
| S3_SECRET_ACCESS_KEY | R2 secret key |
| ZEPTO_API_KEY | ZeptoMail API key |
| EMAIL_FROM | noreply@communication.feturtles.com |
| DRIVE_ENCRYPTION_KEY | 64-char hex (32 bytes) for AES-256-GCM — **new in v1.2** |
| GOOGLE_OAUTH_CLIENT_ID | Google Cloud OAuth client ID — **new in v1.2** |
| GOOGLE_OAUTH_CLIENT_SECRET | Google Cloud OAuth client secret — **new in v1.2** |
| GOOGLE_OAUTH_REDIRECT_URI | /auth/drive/google/callback — **new in v1.2** |
| ONEDRIVE_OAUTH_CLIENT_ID | Azure AD app registration client ID — **new in v1.2** |
| ONEDRIVE_OAUTH_CLIENT_SECRET | Azure AD client secret — **new in v1.2** |
| ONEDRIVE_OAUTH_REDIRECT_URI | /auth/drive/onedrive/callback — **new in v1.2** |
