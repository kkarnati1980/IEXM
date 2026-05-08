# Baseline Interface Control Document (ICD)
## Physical-World Interaction Platform

This file is the running history of the Interface Control Document across all known versions.
The v1.0 text is the spine. Changes from v1.2 are annotated inline at the point where they apply.

**Important scope note:** ICD v1.0 was a narrow, frozen contract issued to the external IoT vendor team — covering device/kiosk interface only (5 API endpoints). ICD v1.2 expands the scope to the full platform interface: device, API, auth, storage, email, Drive integration, CRM, webhooks, and database. New v1.2 sections that cover areas outside v1.0's scope are marked *"new in v1.2, no original ancestor."*

Re-run `/baseline` any time a new build version drops — it will extend this file automatically.

---

## Version History

| Version | Date | Author | Summary |
|---|---|---|---|
| v1.0 | 7 May 2026 | Platform Team | Frozen device/edge-runtime interface contract issued to IoT vendor team. Based on Master Spec v1.1. |
| v1.2 | 8 May 2026 | Platform Team | Full platform ICD — expands scope to cover all external interfaces: auth, storage, email, Drive, CRM, webhooks, DB. |

*Note: No ICD v1.1 was issued. The first version frozen and sent to the external vendor was v1.0 (7 May 2026).*

---

## Change Summary

| Version | Added | Changed | Removed | Clarified |
|---|---|---|---|---|
| v1.2 | 10 | 4 | 0 | 3 |

---

## Quick Index — All Changes

**v1.2 changes**
- [v1.2-A1] §2 New system components: PostgreSQL, R2, ZeptoMail, Google Drive, OneDrive, Web Frontend, CRM systems
- [v1.2-A2] §4 Full API contract (261+ routes) vs. 5 device endpoints in v1.0
- [v1.2-A3] §5 Auth interface: JWT structure, password hashing, MFA OTP, Google Drive OAuth, OneDrive OAuth, AES-256-GCM
- [v1.2-A4] §6 Storage interface: Cloudflare R2, export file formats, HMAC-signed download links
- [v1.2-A5] §7 Email interface: ZeptoMail HTTP API, 17 notification templates, retry logic
- [v1.2-A6] §8 Drive Storage interface: Google Drive API, Microsoft Graph API, token encryption, attendee access tokens
- [v1.2-A7] §9 CRM integration interface: Salesforce, HubSpot, Zoho deletion dispatch
- [v1.2-A8] §10 Webhook interface: 6 event types, delivery retry, payload schemas
- [v1.2-A9] §11 Database interface: connection, RLS, audit log tamper resistance, migration versioning
- [v1.2-A10] §13 API error codes expanded (12 codes vs. 9 in v1.0 Appendix A)
- [v1.2-C1] §3 Device API paths updated (e.g. /device/config → /devices/:id/config)
- [v1.2-C2] §5 JWT claims expanded with type field; org_id added
- [v1.2-C3] §3 Heartbeat: 2 missed = fleet warning, 5 missed = critical (v1.0 said 2 missed = warning, 5 missed = critical — confirmed same)
- [v1.2-C4] §12 Environment variables expanded with Drive OAuth vars

---

## 1. Executive Summary and Purpose

**v1.0 (original):**
This document is the frozen interface contract that the IoT Platform Team must implement on every device that will connect to the platform. It defines:
- What a device is allowed to do, and what it is not allowed to do.
- How a device authenticates and receives its operating configuration.
- The exact request and response shape of every device-facing API.
- How taps are captured, queued, and synchronised — with offline-first guarantees.
- The kiosk state machine, NFC handling, QR fallback, and reboot recovery.
- Heartbeat, health monitoring, incident reporting, and diagnostics.
- Hardware baseline, security requirements, and field-operations procedures.
- Mandatory precautions and acceptance checks the IoT team must satisfy before any device is permitted to connect to a live event.

| Field | Value |
|---|---|
| Document type | Frozen Interface Control Document (ICD) |
| Document status | FROZEN — v1.0 (no edits without formal change-control) |
| Source of truth | Production build of the platform (equivalent to Master Spec v1.1) |
| Audience | External IoT Platform / Device Vendor Team |
| Issue date | 7 May 2026 |
| Version | 1.0 (Frozen) |
| Change control | Any change requires written approval from the platform Engineering Lead and re-issue of the ICD with a new version number. |

**Authoritative use:** The IoT vendor team is not permitted to assume, infer, or implement any behaviour beyond what is written here. Where the platform's design documents and this ICD differ, this ICD wins. Where this ICD is silent, the vendor must raise a change-control request — silence is not permission.

> [v1.2 CHANGED from §1] **Scope expanded significantly.** v1.2 defines this ICD as "the authoritative reference for integration teams, security review, and infrastructure operations" — covering all interfaces, not just device. The v1.0 audience was exclusively the external IoT vendor team. The v1.2 audience is all integration consumers.

---

## 2. System Components

**v1.0 (implicit from context — no explicit component table in v1.0):**

The platform exposes an HTTPS API to devices. The device is the only edge component. Everything beyond the API gateway is platform-owned.

> [v1.2 ADDED §2, no original ancestor] **Full system component table:**

| ID | Component | Description |
|---|---|---|
| 2.1 | Codex API Server | Node.js v25.8.2 ESM; custom router; Railway service; port 3000 |
| 2.2 | PostgreSQL Database | Railway PostgreSQL; switchback.proxy.rlwy.net:42150; 79 tables; RLS enabled |
| 2.3 | Cloudflare R2 Storage | S3-compatible object storage; STORAGE_BACKEND=s3; no egress fees |
| 2.4 | ZeptoMail Email Service | HTTP API; handles all transactional email; 17 templates |
| 2.5 | Google Drive API | OAuth 2.0 read-only; folder listing, file metadata, viewer URLs |
| 2.6 | Microsoft OneDrive (Graph API) | OAuth 2.0 read-only; Files.Read scope; pending Azure app registration |
| 2.7 | Kiosk/Edge Device Runtime | Physical NFC reader; authenticates as device_principal; heartbeat + tap ingestion |
| 2.8 | Web Frontend | 32 HTML pages; Vanilla HTML/CSS/JS; shared-app.css light theme; IBM Plex Sans |
| 2.9 | External CRM Systems | Salesforce, HubSpot, Zoho — deletion dispatch on DSR delete events |

---

## 3. Device Interface Contract

### 3.1 What the IoT Platform Team Owns (v1.0)

| Domain | Owned by IoT Platform Team |
|---|---|
| Device hardware | Procurement, assembly, labelling, MDM enrolment, kiosk-mode lock-down, firmware updates |
| Edge runtime | PWA / native app satisfying this ICD — boot controller, NFC adapter, queue store, sync engine, branding cache, diagnostics, heartbeat agent, QR fallback |
| Local data layer | Encrypted local queue, branding asset cache, diagnostics ring buffer, secure token storage |
| Connectivity | Wi-Fi / cellular fallback configuration, network health detection, backoff and retry behaviour |
| Field operations | Pre-dispatch tests, on-site go-live tests, end-of-day reconciliation, on-floor incident response |
| Compliance with this ICD | Demonstrating, with evidence, that every device passes the Acceptance Test Set (Appendix C) before any live event |

### 3.2 What the IoT Platform Team Does NOT Own (v1.0)

| Domain | Owned by the platform |
|---|---|
| Backend services | API gateway, auth, event service, device registry, interaction service, consent service, integration service, analytics, observability |
| Data persistence | Source-of-truth database, file storage, audit logs, analytics aggregations |
| User dashboards | Vendor lead inbox, sponsor analytics, organiser fleet console, platform admin |
| Trust enforcement | Consent gating, tenant isolation, response masking, export approval workflow |
| CRM, email, webhooks | All outbound integrations from the platform |

### 3.3 Device Registration

> [v1.2 CHANGED from §3 original] The v1.0 ICD handled authentication by pre-provisioned long-lived credential. v1.2 formalises a registration endpoint:

```
POST /devices/register
Body: { "device_name": string, "tenant_id": uuid, "registration_token": string }
Response: { "device_id": uuid, "credential_token": string (raw — store securely) }
```
Note: credential_token returned once only; hashed before storage.

### 3.4 Device Authentication

```
POST /devices/auth
Body: { "device_id": uuid, "credential_token": string }
Response: { "token": string (JWT, device_principal role, 24h expiry) }
```
Set `Authorization: Bearer <token>` on all subsequent device requests.

### 3.5 Heartbeat Protocol (v1.0)

```
POST /device/heartbeat
Body:
{
  "device_id": "uuid",
  "battery_percent": 88,
  "wifi_strength": -45,
  "mobile_signal": -70,
  "reader_status": "connected",
  "app_version": "1.0.0",
  "local_queue_depth": 3,
  "timestamp": "2026-05-07T09:00:00Z"
}
```

Expected interval: every 60 seconds. 2 missed heartbeats → fleet-console warning. 5 missed heartbeats → critical incident.

> [v1.2 CHANGED from §3.5] **Path changed:** `/device/heartbeat` → `POST /devices/:id/heartbeat`. Body fields `wifi_strength` and `mobile_signal` not mentioned in v1.2 simplified form; other fields confirmed same. Response: 202 Accepted (unchanged).

### 3.6 NFC Tap Ingestion (v1.0)

```
POST /interactions/tap
Body: { "device_id": uuid, "event_id": uuid, "stall_id": uuid,
        "tap_type": "phone", "reader_uid": null, "ndef_payload": null,
        "local_event_id": string, "timestamp": ISO8601 }
Response: {
  "interaction_id": uuid,
  "resolution_status": "resolved",
  "next_action": "open_mobile_link",
  "attendee_preview": { ... },
  "branding_payload": { ... },
  "customer_link": string
}
```

> [v1.2 CHANGED from §3.6] **Simplified response in v1.2:** returns `{ "interaction_id": uuid, "consent_status": "granted"|"denied"|"unknown" }`. The `attendee_preview`, `branding_payload`, and `customer_link` fields from v1.0 are not present in the v1.2 simplified form (may still be returned; v1.2 spec only documents the minimum fields).

### 3.7 Config Fetch (v1.0)

```
GET /device/config
Response: {
  "device_id": uuid,
  "event_id": uuid,
  "stall_id": uuid,
  "branding_profile_id": uuid,
  "feature_flags": { "kiosk_disabled": false, "qr_enabled": true, "card_uid_enabled": true },
  "offline_expiry_window_minutes": 240,
  "config_version": string
}
```

> [v1.2 CHANGED from §3.7] **Path changed:** `GET /device/config` → `GET /devices/:id/config`. Response confirmed to include `event_id`, `stall_id`, `data_policy`, `firmware_target`. Branding and feature flag fields not explicitly named in v1.2 simplified form.

### 3.8 Incident Reporting (v1.0)

```
POST /device/incident
Body: { "device_id": uuid, "incident_type": string, "severity": "warning"|"critical",
        "detail": string, "occurred_at": ISO8601 }
```

Allowed `incident_type` values: `reader_disconnected`, `app_crash`, `low_battery`, `tamper`, `network_outage`.

> [v1.2 CHANGED from §3.8] **Path changed:** `POST /device/incident` → `POST /devices/:id/incidents`. Body field `occurred_at` confirmed as `details` in v1.2; field `severity` values changed from `"warning"|"critical"` to `"low"|"medium"|"high"|"critical"`.

### 3.9 Offline Sync Upload (v1.0)

```
POST /device/sync
Body: {
  "device_id": uuid,
  "items": [ {
    "device_id": uuid, "event_id": uuid, "stall_id": uuid,
    "tap_type": "phone"|"card"|"qr",
    "reader_uid": null, "ndef_payload": null,
    "local_event_id": string,
    "timestamp": ISO8601
  } ]
}
Response: {
  "results": [ {
    "local_event_id": string,
    "status": "created"|"duplicate"|"rejected",
    "interaction_id": uuid,
    "reason": string
  } ]
}
```

Maximum 100 items per call. Chronological order required.

> [v1.2 CLARIFIED §3.9] IoT sync documented via `GET /iot/runs` and `POST /iot/runs` for admin integration run management. The device-level `POST /device/sync` path is superseded by `POST /devices/:id/sync` per v1.2 naming convention.

### 3.10 IoT Sync Runs (v1.2 — new)

> [v1.2 ADDED §3.10, no original ancestor]
```
POST /iot/runs   — Trigger IoT integration sync run
GET /iot/runs    — List sync run history with status and duration
```

---

## 4. API Interface Contract

### 4.1 Common Request Headers (v1.0)

```
Authorization: Bearer <JWT>
X-Request-Id: <uuid-v4>
Content-Type: application/json
```

> [v1.2 ADDED §4.1] Cookie-based auth also supported: `Cookie: token=<JWT>` (httpOnly). Alternative to Authorization header for browser sessions.

### 4.2 Common Response Schema

| Status | Meaning | Body |
|---|---|---|
| 200 | OK | { data: ... } |
| 201 | Created | { id: uuid, ... } |
| 202 | Accepted, async | No body |
| 400 | Bad Request | { error: "validation_error", message: string } |
| 401 | Unauthorised | { error: "unauthorized" } |
| 403 | Forbidden | { error: "forbidden", message: string } |
| 404 | Not Found | { error: "not_found" } |
| 409 | Conflict | { error: "conflict", message: string } |
| 422 | Validation Error | { error: "validation_error" } |
| 429 | Rate Limited | { error: "rate_limit_exceeded" } |
| 5xx | Server Error | { error: "internal_error" } |

**v1.0 error response shape (device-specific):**
```json
{
  "code": "VALIDATION_ERROR",
  "message": "Human-readable description.",
  "request_id": "uuid",
  "details": { }
}
```

> [v1.2 CLARIFIED §4.2] The detailed error shape from v1.0 is confirmed as the standard for device-facing endpoints. Browser-facing endpoints return simplified `{ error: string }` format.

### 4.3 Rate Limiting (v1.2 — new)

> [v1.2 ADDED §4.3, no original ancestor] Per-bucket rate limits:
> - Auth endpoints: 20 requests/window
> - Public endpoints: 20 requests/window
> - Sensitive endpoints: 30 requests/window
> - Admin endpoints: 15 requests/window

---

## 5. Authentication Interface

### 5.1 JWT Structure

**v1.0 (implicit — device credential was a long-lived bearer token, not a JWT):**
Device credential is a long-lived token hashed and stored in device registry. Not a JWT.

> [v1.2 CHANGED from §5.1] **Users and devices now both use JWTs:**

| Claim | Type | Description |
|---|---|---|
| sub | uuid | User or device ID |
| role | string | Primary role (platform_admin, organizer_admin, vendor_manager, sponsor_user, ops_user, device_principal) |
| tenant_id | uuid | Tenant the principal belongs to |
| org_id | uuid? | Organisation context (multi-org users) — **new in v1.2** |
| iat | unix timestamp | Issued at |
| exp | unix timestamp | Expiry (iat + 86400s) |
| type | string | "user" or "device" — **new in v1.2** |

### 5.2 Password Hashing

> [v1.2 ADDED §5.2, no original ancestor]
Algorithm: scrypt (native Node.js crypto module)
Parameters: N=16384, r=8, p=1, keyLen=64 bytes
Salt: 16 random bytes, stored with hash as hex:hex

### 5.3 MFA OTP Flow

> [v1.2 ADDED §5.3, no original ancestor]
- Step 1: POST /auth/send-otp — Body: { email } → sends 6-digit OTP via email (10-min expiry)
- Step 2: POST /auth/verify-otp — Body: { email, otp } → returns JWT if valid
- OTP is single-use; stored as bcrypt hash; expired OTPs rejected with 401.

### 5.4 Google Drive OAuth 2.0 Flow

> [v1.2 ADDED §5.4, no original ancestor]
1. GET /stalls/:stallId/drive/connect/google → redirect to Google consent page
2. User grants consent → Google redirects to /auth/drive/google/callback?code=...&state=...
3. Platform exchanges code for tokens; encrypts with AES-256-GCM; stores in stall_drive_connections

Scopes: `https://www.googleapis.com/auth/drive.readonly`, `openid`, `email`

### 5.5 OneDrive OAuth 2.0 Flow

> [v1.2 ADDED §5.5, no original ancestor]
1. GET /stalls/:stallId/drive/connect/onedrive → redirect to Microsoft login
2. User grants consent → Microsoft redirects to /auth/drive/onedrive/callback?code=...&state=...
3. Platform exchanges code for tokens; encrypts and stores as above

Scopes: `Files.Read`, `Files.Read.All`, `User.Read`, `offline_access`

### 5.6 AES-256-GCM Token Encryption

> [v1.2 ADDED §5.6, no original ancestor]
Key: DRIVE_ENCRYPTION_KEY env var — 64 hex chars (32 bytes)
IV: 12 random bytes generated per encryption, prepended to ciphertext
Auth tag: 16 bytes, appended to ciphertext
Storage format: base64(iv + ciphertext + authTag)

### 5.7 Device Credential Lifecycle (v1.0)

| Stage | Responsibility | Behaviour |
|---|---|---|
| Provisioning | Platform | Device registered in device registry. Credential generated and handed to IoT team via secure channel. |
| Bootstrap | IoT Vendor | Credential loaded via MDM. Never in source code, build artefacts, or logs. |
| Storage | IoT Vendor | Stored in OS-level secure storage (Android Keystore). Never in shared preferences or plain files. |
| Use | IoT Vendor | Presented in Authorization header. Never echoed in responses or logs. |
| Rotation | Both | Platform may rotate; rotation signalled out-of-band. Device must support replacement without losing local queue. |
| Revocation | Platform | Revoked credential receives 401 on every call. Device must enter LOCKED_UNASSIGNED, preserve queue. |

---

## 6. Storage Interface

> [v1.2 ADDED §6, no original ancestor]

### 6.1 Cloudflare R2 (S3 API)

| Config | Value |
|---|---|
| STORAGE_BACKEND | s3 |
| S3_ENDPOINT | https://<account>.r2.cloudflarestorage.com |
| S3_REGION | auto |
| S3_BUCKET | codex-exports (or configured bucket name) |
| Auth | S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY |

### 6.2 Export File Formats

| Export Type | Format | Notes |
|---|---|---|
| Full tenant export | JSON + CSV | Zipped; all tables for tenant |
| DSR export | JSON | All data for one attendee |
| Vendor lead export | CSV | Leads from vendor's stall interactions |
| Snapshot comparison | CSV | Exported from compare endpoint |

### 6.3 Download Links

Download URLs are HMAC-signed with the SESSION_SECRET.
Format: `/exports/:id/download?sig=<hmac>&exp=<unix_timestamp>`
Links expire after 1 hour. Single-use enforcement via download_count tracking.

---

## 7. Email Interface

> [v1.2 ADDED §7, no original ancestor]

### 7.1 ZeptoMail HTTP API

```
Endpoint: https://api.zeptomail.in/v1.1/email
Method: POST
Headers: Authorization: Zoho-enczapikey <ZEPTO_API_KEY>, Content-Type: application/json
From: noreply@communication.feturtles.com
```

### 7.2 Notification Templates (17)

| Template Key | Trigger |
|---|---|
| user_invitation | New user invite with accept link (7-day expiry) |
| invite_expiry_reminder | Reminder that invite expires soon |
| account_activated | Account activation confirmation |
| password_reset | Password reset link (24-hour expiry) |
| break_glass_pending_approval | Notify approver of pending break-glass request |
| break_glass_organizer_alert | Alert organizer that break-glass was used |
| data_policy_changed | Notify when event data policy changes |
| retention_purge_completed | Confirm scheduled data purge completed |
| retention_expiry_warning | Warn of upcoming data purge |
| full_export_ready | Full export download link |
| dsr_export_ready | DSR export download link |
| dsr_delete_confirmed | DSR deletion confirmation |
| offboarding_deletion_certificate | Tenant offboarding deletion certificate |
| offboarding_initiated | Offboarding start confirmation |
| offboarding_deletion_reminder_14d | 14-day pre-deletion reminder |
| offboarding_deletion_reminder_3d | 3-day pre-deletion reminder |
| mfa_otp | MFA one-time password (10-min expiry) |

### 7.3 Retry Logic

3 delivery attempts with exponential backoff (1 min, 5 min, 30 min).
After 3 failures: status set to `dead_letter`; notification marked failed.
Worker: email-delivery-worker.mjs (continuous queue processor).

---

## 8. Drive Storage Interface

> [v1.2 ADDED §8, no original ancestor]

### 8.1 Google Drive OAuth Scopes

| Scope | Purpose |
|---|---|
| https://www.googleapis.com/auth/drive.readonly | Read file metadata and contents |
| https://www.googleapis.com/auth/userinfo.email | Get vendor email for connection record |
| openid | OIDC identity token |

### 8.2 Google Drive API Endpoints Used

| Endpoint | Purpose |
|---|---|
| GET .../drive/v3/files?q=mimeType='application/vnd.google-apps.folder' | List root-level folders |
| GET .../drive/v3/files?q='<folderId>'+in+parents | List files in folder |
| GET .../drive/v3/files/:fileId?fields=webViewLink,webContentLink | Get viewer and download URLs |
| POST https://oauth2.googleapis.com/token | Exchange auth code / refresh token |
| POST https://oauth2.googleapis.com/revoke | Revoke tokens on disconnect |

### 8.3 OneDrive OAuth Scopes

| Scope | Purpose |
|---|---|
| Files.Read | Read user's files |
| Files.Read.All | Read all files in accessible drives |
| User.Read | Get user profile / email |
| offline_access | Get refresh token |

### 8.4 Microsoft Graph API Endpoints Used

| Endpoint | Purpose |
|---|---|
| GET .../v1.0/me/drive/root/children | List root folders |
| GET .../v1.0/me/drive/items/:itemId/children | List folder contents |
| GET .../v1.0/me/drive/items/:itemId | Get file metadata + webUrl |
| POST .../common/oauth2/v2.0/token | Exchange code / refresh token |

### 8.5 Token Encryption at Rest

Algorithm: AES-256-GCM
Key: 32-byte key from DRIVE_ENCRYPTION_KEY (64 hex chars)
IV: 12 random bytes per encryption; stored prepended to ciphertext
Auth tag: 16 bytes; stored appended to ciphertext
Storage: `base64(iv || ciphertext || authTag)` in stall_drive_connections.access_token / refresh_token

### 8.6 Attendee Access Token Format

Token: 32-byte random hex string (64 hex chars)
Stored in: stall_folder_access.access_token (indexed)
URL: /docs/:accessToken — no authentication required
Expiry: configurable per grant (default 30 days); validated on each request
Access log: every folder browse, file view, and download recorded in stall_folder_access_log

### 8.7 Document Viewer URL Format

| Provider | Viewer URL Format |
|---|---|
| Google Drive | https://drive.google.com/file/d/<fileId>/preview |
| OneDrive | https://onedrive.live.com/embed?cid=<cid>&resid=<resid>&authkey=<key> |

---

## 9. CRM Integration Interface

> [v1.2 ADDED §9, no original ancestor]

CRM integrations are triggered on DSR delete events to cascade deletion to external CRMs.

| CRM | API | Deletion Endpoint |
|---|---|---|
| Salesforce | REST API v58 | DELETE /services/data/v58.0/sobjects/Contact/<id> |
| HubSpot | Contacts API v3 | DELETE /crm/v3/objects/contacts/<id> |
| Zoho CRM | Zoho CRM API v6 | DELETE /crm/v6/Contacts/<id> |

Connection credentials stored encrypted in crm_connections. Deletion dispatch records stored in downstream_deletion_records. crm_sync_jobs handles async sync; crm_deletion.mjs handles deletion cascade.

---

## 10. Webhook Interface

> [v1.2 ADDED §10, no original ancestor]

Webhooks delivered via HTTP POST to subscriber endpoints registered in webhook_subscriptions.

| Event Type | Trigger | Payload Fields |
|---|---|---|
| attendee.tap | NFC tap ingested | interaction_id, attendee_id, stall_id, tap_time, consent_status |
| dsr.delete_completed | DSR deletion processed | dsr_id, attendee_id, tenant_id, completed_at |
| export.ready | Export file ready | export_id, download_url, expires_at |
| break_glass.approved | Break-glass approved | access_id, requester_id, approver_id, expires_at |
| device.incident | Device incident reported | device_id, incident_type, severity, reported_at |
| retention.purge_completed | Retention purge ran | event_id, records_purged, purged_at |

Delivery: HTTP POST; 3 retries with exponential backoff; results stored in webhook_deliveries.

---

## 11. Database Interface

> [v1.2 ADDED §11, no original ancestor]

### 11.1 Connection

```
Driver: pg (node-postgres)
Connection: DATABASE_URL (PostgreSQL with SSL)
Runtime role: app_runtime (reduced privileges; no DDL)
SSL: sslRejectUnauthorized=false for Railway internal connections
```

### 11.2 Row Level Security (Tenant Isolation)

All tables with tenant_id have RLS enabled. The app_runtime role can only see rows where tenant_id matches the current session setting (set at connection start via `SET app.current_tenant_id = <uuid>`). Cross-tenant access is impossible without explicit platform_admin bypass.

### 11.3 Audit Log Tamper Resistance

`REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime` — the audit log is append-only. No code path can modify or delete audit log entries. Privacy audit log follows same pattern.

### 11.4 Migration Versioning

54 migration files in apps/api/migrations/ (001_init.sql through 054_fix_stall_rls.sql).
Migration state tracked in schema_migrations table. Migrator: db/migrator.mjs.

---

## 12. Required Environment Variables

| Variable | Example | Required | Description |
|---|---|---|---|
| DATABASE_URL | postgresql://... | Required | Railway PostgreSQL connection string |
| USE_POSTGRES | true | Required | Enables PostgreSQL repositories |
| BASE_URL | https://... | Required | API base URL for email links |
| SESSION_SECRET | (min 32 chars) | Required | JWT signing secret |
| STORAGE_BACKEND | s3 | Required | Enables R2/S3 file storage |
| S3_BUCKET | string | Required | R2 bucket name |
| S3_REGION | auto | Required | R2 region |
| S3_ENDPOINT | https://... | Required | R2 account endpoint |
| S3_ACCESS_KEY_ID | string | Required | R2 access key |
| S3_SECRET_ACCESS_KEY | string | Required | R2 secret key |
| ZEPTO_API_KEY | string | Required | ZeptoMail API key |
| EMAIL_FROM | email | Required | From address for transactional emails |
| DRIVE_ENCRYPTION_KEY | 64 hex chars | Required for Drive | AES-256-GCM key for OAuth token encryption |
| GOOGLE_OAUTH_CLIENT_ID | string | Required for Google Drive | Google Cloud OAuth 2.0 client ID |
| GOOGLE_OAUTH_CLIENT_SECRET | string | Required for Google Drive | Google Cloud OAuth 2.0 client secret |
| GOOGLE_OAUTH_REDIRECT_URI | https://... | Required for Google Drive | OAuth callback URL |
| ONEDRIVE_OAUTH_CLIENT_ID | string | Required for OneDrive | Azure AD app client ID |
| ONEDRIVE_OAUTH_CLIENT_SECRET | string | Required for OneDrive | Azure AD client secret |
| ONEDRIVE_OAUTH_REDIRECT_URI | https://... | Required for OneDrive | OAuth callback URL |
| DATABASE_RUNTIME_ROLE | app_runtime | Optional | Postgres role to SET on connection |

> [v1.2 CHANGED from §12] Drive OAuth variables (DRIVE_ENCRYPTION_KEY, GOOGLE_OAUTH_*, ONEDRIVE_OAUTH_*) are new in v1.2. v1.0 did not require these.

---

## 13. API Error Codes

**v1.0 Appendix A (device-specific):**

| Code | HTTP | Meaning | Device behaviour |
|---|---|---|---|
| UNAUTHENTICATED | 401 | Missing, invalid, expired, or revoked credential | Stop all calls. Enter LOCKED_UNASSIGNED. Surface diagnostic banner. Preserve queue. |
| ROLE_FORBIDDEN | 403 | Endpoint not callable by Device Principal | Treat as a build defect. Stop calling. Raise an incident. |
| TENANT_MISMATCH | 403 | Resource belongs to a different tenant | Should never occur. Raise critical incident. |
| SCOPE_FORBIDDEN | 403 | Caller not scoped to requested event/stall/resource | Refresh /device/config; if persists, raise critical incident. |
| ASSIGNMENT_MISMATCH | 422 | Item event_id/stall_id does not match active assignment | Mark item failed_terminal. Continue with next item. |
| VALIDATION_ERROR | 422 | Request shape, enum, or field invalid | Mark item failed_terminal. Log payload (PII redacted). Do not retry. |
| TRANSPORT_NOT_SECURE | 403 | Request did not arrive over trusted secure transport | Verify TLS chain. Raise critical incident. Block production rollout. |
| RESOURCE_NOT_FOUND | 404 | Requested object not found in caller scope | Refresh /device/config; do not retry original call. |
| RATE_LIMITED | 429 | Gateway rate limit applied | Apply exponential backoff. Honour Retry-After. |
| PROVIDER_UNAVAILABLE | 503 | Downstream component temporarily unavailable | Treat as failed_retryable. Backoff and retry. |

> [v1.2 ADDED §13] Additional error codes not present in v1.0:
> - `unauthorized` (401) — Missing or invalid JWT (browser sessions)
> - `forbidden` (403) — Role does not have permission for this route
> - `not_found` (404) — Resource not found or not accessible to this tenant
> - `conflict` (409) — State conflict (e.g., drive connection already active)
> - `not_configured` (503) — Drive OAuth env vars not configured on server
> - `token_error` (502) — Drive OAuth token exchange or refresh failed
> - `network_error` (502) — Drive provider API unreachable
> - `db_permission_error` (500) — PostgreSQL RLS or permission denied (internal)
> - `server_error` (500) — Unexpected internal error
> - `internal_error` (500) — Generic server error

---

## 14. Non-Negotiable System Laws (Device) (v1.0)

| # | Law | Implication for the device |
|---|---|---|
| L1 | Every tap must be stored locally first. | UI must not show success before the local commit. |
| L2 | Every cloud sync must be idempotent by (device_id, local_event_id). | Device must generate stable local_event_id at capture and reuse it across all retries. |
| L3 | Consent gates all personal-data release. | Device must never display, log, or transmit PII beyond the minimum required for sync. |
| L4 | No bulk attendee database ingestion. | Device must never import, cache, or hold an attendee list. |
| L5 | Every query and write must be tenant-scoped and event-scoped. | Device must use only the assignment returned by GET /device/config. |
| L6 | Sponsors see aggregates by default. | Device is not aware of sponsor-tier data; it only sends interactions. |
| L7 | Every sensitive action must be auditable. | Device must include stable X-Request-Id on every API call. |
| L8 | No AI or third-party enrichment in the critical tap path. | Device must never block the tap UI on enrichment. |
| L9 | Kiosk interaction must work without internet. | All edge functions must work fully offline. |
| L10 | Public leaderboard must never display personal data. | Device must never render PII on any attendee-facing surface. |

---

## 15. Local Storage Model (v1.0)

### config_store

| Field | Notes |
|---|---|
| event_id | Active event from /device/config |
| stall_id | Active stall from /device/config |
| branding_profile_id | Reference into branding_assets_store |
| feature_flags | JSON object — kiosk_disabled, qr_enabled, etc. |
| offline_expiry_window_minutes | Window for offline tap eligibility |
| config_version | Change-detection token |
| fetched_at | ISO timestamp of last successful fetch |

### queue_store

| Field | Notes |
|---|---|
| local_event_id | Device-generated; idempotency key |
| device_id | Owning device |
| event_id | Event scope at capture |
| stall_id | Stall scope at capture |
| tap_type | phone, card, or qr |
| reader_uid | For card; null otherwise |
| ndef_payload | For phone NDEF; null otherwise |
| occurred_at | ISO timestamp from device clock at capture |
| queue_sequence_number | Monotonically increasing — preserves chronological order |
| sync_status | queued, syncing, synced, failed_retryable, failed_terminal, suppressed_duplicate |
| retry_count | Incremented on every retry attempt |
| server_interaction_id | Set after successful sync |

### Allowed sync_status Values

| Value | Meaning |
|---|---|
| queued | Captured locally, not yet uploaded |
| syncing | Currently being uploaded |
| synced | Server accepted (created or duplicate) |
| failed_retryable | Transient failure; will retry |
| failed_terminal | Server rejected permanently; stays visible in diagnostics |
| suppressed_duplicate | Locally-detected duplicate (debounce); not uploaded |

---

## 16. Device State Machine (v1.0)

### States

| State | Meaning |
|---|---|
| BOOTING | Initialise local services, storage, reader adapter, network monitor |
| CONFIG_LOADING | Load cached config, attempt GET /device/config, verify assignment and branding |
| CONFIG_ERROR | No usable config; attendee flow blocked; admin retry only |
| READER_ERROR | NFC reader unavailable; QR fallback remains visible if config valid |
| LOCKED_UNASSIGNED | No active assignment; neutral idle screen; no attendee flow |
| IDLE | Default branded state with sponsor creative and QR fallback; online |
| OFFLINE_IDLE | Same as IDLE but explicit offline status for diagnostics |
| TAP_READING | NFC processing in flight; local queue write in progress |
| INTERACTION_ACTIVE | Attendee preview/interaction state with sponsor panel and reset timer |
| INTERACTION_EXCEPTION | Fallback for invalid read or non-recoverable preview issue |
| SYNCING_BACKGROUND | Concurrent state; queued upload and retry alongside other states |
| DIAGNOSTICS | Hidden support state; operational controls only; no destructive queue wipes |

### Permitted Transitions

- BOOTING → CONFIG_LOADING
- CONFIG_LOADING → IDLE | OFFLINE_IDLE | LOCKED_UNASSIGNED | CONFIG_ERROR | READER_ERROR
- IDLE / OFFLINE_IDLE → TAP_READING (on NFC event) | DIAGNOSTICS (gesture + PIN)
- TAP_READING → INTERACTION_ACTIVE (on successful local write) | INTERACTION_EXCEPTION (on invalid read)
- INTERACTION_ACTIVE → IDLE / OFFLINE_IDLE on auto-reset timer (default 15s, max 20s with staff action)
- Any state → CONFIG_ERROR if 401 UNAUTHENTICATED received
- Any state → READER_ERROR on reader disconnect; returns to IDLE on reconnect

---

## 17. Runtime Thresholds (v1.0)

| Setting | Value |
|---|---|
| Tap response target | ≤ 300 ms |
| Active screen auto-reset | 15 seconds (default), max 20 seconds with staff action |
| Reader debounce window | 2 seconds |
| Heartbeat frequency | 60 seconds |
| Missed-heartbeat warning | 2 missed (≈120 seconds) |
| Missed-heartbeat critical | 5 missed (≈300 seconds) |
| Battery warning | < 20% |
| Battery critical | < 10% |
| Sync retry interval | 30 seconds (initial) |
| Sync batch maximum | 100 items per call |
| Queue depth warning | > 100 unsynced items |
| Queue depth critical | > 500 unsynced items |
| Config refresh cadence | Every 5 minutes (online + IDLE), plus on every reconnect |
| Diagnostics PIN rotation | Every 90 days minimum |
| Local diagnostic log retention | Minimum 5,000 entries OR 7 days |

---

## 18. Security Requirements (v1.0)

- All traffic is HTTPS over TLS 1.2 or higher. TLS 1.3 preferred.
- The device must validate the platform's server certificate. Self-signed or expired certificates must be refused.
- Device credential stored in OS-level secure storage (Android Keystore). Never in plain files, shared preferences, or source code.
- Credential never logged, never written to analytics events, never echoed in any API response.
- Credential rotation must be supported without losing local queue state.
- Device must NOT cache attendee personal data beyond the immediate sync payload.
- attendee_preview values displayed during INTERACTION_ACTIVE only; not persisted across auto-reset.
- Diagnostic logs must redact any PII fields. local_event_id and request_id are safe to log; reader_uid and ndef_payload are NOT.
- Every API call must include a unique X-Request-Id (UUID).
- No third-party analytics SDKs without prior approval.
- No remote debugger ports in production builds.

> [v1.2 ADDED §18] **Platform security architecture** (full stack, new in v1.2):

| Control | Implementation |
|---|---|
| JWT | HS256, 24-hour expiry, httpOnly cookie, SameSite=Strict |
| Password hashing | scrypt (N=16384, r=8, p=1) via native Node crypto |
| MFA | Email OTP; 10-minute expiry; single-use; stored hashed |
| OAuth token encryption | AES-256-GCM; key from environment; IV prepended to ciphertext |
| RBAC | Role checked on every route via access-control.mjs matrix |
| Tenant isolation | PostgreSQL RLS on all tables; app_runtime role; tenant_id enforced |
| Break-glass | Dual approval required; auto-expires 4 hours after approval; full audit trail |
| Audit log | REVOKE UPDATE DELETE on audit_logs — tamper-resistant |
| Rate limiting | Per-bucket: auth (20), public (20), sensitive (30), admin (15) per window |
| CSRF | State nonce (32-byte random) on OAuth flows; validated on callback |
| Device auth | device_principal JWT; credential token hashed before storage |
| Export links | HMAC-signed single-use download URLs; 1-hour expiry |

---

## Appendix A — Field Operations Playbook (v1.0)

### Pre-Dispatch Checklist

| # | Check |
|---|---|
| 1 | Device cleaned, labelled with serial number, asset-tagged |
| 2 | NFC reader paired and confirmed functional via diagnostics |
| 3 | Approved app version installed; no debug build artefacts |
| 4 | Kiosk mode enforced; no Settings, browser, or app drawer accessible |
| 5 | Active assignment loaded via GET /device/config; correct event/stall displayed |
| 6 | Branding fully cached locally |
| 7 | Local queue is empty; no orphaned items from previous events |
| 8 | Battery health verified; spare cables and reader packed |

### On-Site Go-Live Checklist

| # | Check |
|---|---|
| 1 | Device placed at correct stall; powered on |
| 2 | Reader connected and responsive |
| 3 | Active event/stall correctly displayed in diagnostics |
| 4 | Run 10 rapid NFC taps — all 10 produce successful UI transition and queue write |
| 5 | Run 1 QR fallback scan — landing page resolves |
| 6 | Disable internet. Run 5 offline taps — all 5 captured in queue |
| 7 | Re-enable internet. Confirm queue drains to zero within 60 seconds |
| 8 | Device visible and "healthy" on platform fleet console |
| 9 | No cross-stall or cross-event taps appeared anywhere on the dashboard |

### End-of-Event Checklist

| # | Check |
|---|---|
| 1 | All devices accounted for; serial numbers cross-checked |
| 2 | Unsynced queue depth is zero on every device, OR documented with reason |
| 3 | Open incidents triaged; critical incidents resolved or formally escalated |
| 4 | Final analytics sanity check: tap count per device matches stall traffic estimate |
| 5 | Diagnostic log exported per device; archived for 90 days minimum |
| 6 | Devices placed back into "inventory" status via platform fleet console |

---

## Appendix B — Acceptance Test Set (v1.0)

| # | Check | Pass criterion |
|---|---|---|
| C1 | Boot to IDLE | Power-on → IDLE in ≤ 60 seconds with valid config and branding |
| C2 | Tap response time | 10 consecutive taps each produce UI transition in ≤ 300 ms |
| C3 | Local-write-first | 20 taps captured with network blocked; queue depth = 20; UI never indicates failure |
| C4 | Idempotent sync | Same batch resent twice → 0 duplicate interactions on platform |
| C5 | Chronological replay | After offline burst of 50 taps, replay arrives in original capture order |
| C6 | Reader disconnect handling | Unplug reader → READER_ERROR within 5s; QR visible; incident POSTed |
| C7 | Reader reconnect | Re-plug reader → IDLE within 10s; new tap accepted |
| C8 | Branding refresh | Trigger config_version change → new asset cached; switch atomic; no idle-screen blank |
| C9 | Reboot recovery | Force reboot with 10 unsynced items → all 10 sync after boot; none lost |
| C10 | App crash recovery | Force-kill app → relaunched within 10s; queue intact; crash counter increments |
| C11 | 401 handling | Revoked credential → LOCKED_UNASSIGNED; queue preserved |
| C12 | Heartbeat cadence | 10 minutes online: ≥ 9 heartbeats received; gaps ≤ 90s |
| C13 | Heartbeat suppression offline | 5 min offline → no heartbeat backlog after reconnect |
| C14 | PII non-persistence | After INTERACTION_ACTIVE timeout: no attendee PII in queue, logs, or screenshots |
| C15 | No forbidden endpoints | 1-hour network capture shows zero calls to endpoints outside Section 5 |
| C16 | Credential security | Forensic image: credential not extractable from app data |
| C17 | Diagnostics PIN gate | Diagnostics requires gesture + PIN; no other path opens the screen |
| C18 | No destructive actions in field UI | Diagnostics screen offers no wipe-queue, no reset-identity action |
| C19 | TLS hardening | MITM proxy with self-signed cert is rejected; no fallback to HTTP |
| C20 | Kiosk lock-down | Swipe-out, notification pull, browser — all fail |

---

## Appendix C — Glossary (v1.0)

| Term | Definition |
|---|---|
| Device Principal | The actor identity assigned to a kiosk. Limited to the device-facing endpoints. |
| ICD | Interface Control Document. The frozen, binding contract between the platform and the IoT vendor. |
| local_event_id | Device-generated unique identifier per tap. Used as the idempotency key for sync. |
| queue_sequence_number | Monotonically increasing integer per device session. Used to enforce chronological replay. |
| Tap | A successful NFC, card, or QR-fallback interaction captured at the device. |
| Sync | The act of uploading queued tap events from the device to the platform. |
| Heartbeat | A health snapshot the device sends every 60 seconds. |
| Incident | A device-side event explicitly reported to the platform via POST /device/incident. |
| Branding profile | A versioned set of visual assets tied to an event/stall. |
| Consent | Attendee's release decision controlling what personal data the platform may share. Out of scope for the device. |
| Tenant | The top-level isolation boundary on the platform. Each device belongs to exactly one tenant. |

---

## Appendix D — Change Control Process (v1.0)

A change-control request (CCR) is required for:
- Any change to the device's observable behaviour against the contracts in Sections 3–17.
- Any new endpoint usage beyond the five device endpoints.
- Any new value of any closed enum (sync_status, tap_type, incident_type, state).
- Any deviation from the runtime thresholds in Section 17.
- Any change to credential storage, log fields, or PII handling.

**CCR Approval Path:**
1. Vendor Engineering Lead submits CCR in writing to the platform Engineering Lead.
2. Platform Engineering Lead reviews within 5 business days.
3. On approval, this ICD is re-issued as a new version with the change incorporated.
4. Implementation begins only after the new ICD version is issued.
5. Migration window stated in each new version (typically 30–60 days).

> [v1.2 CLARIFIED §D] Change control applies to the full platform ICD in v1.2, not just device behaviour. The IoT vendor CCR process remains applicable for device-interface changes.
