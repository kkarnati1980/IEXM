# User Management, RBAC, Platform Admin Panel & Data Sovereignty Controls
## Complete Implementation Plan — v4 (Codebase-Verified)
### Based on: Physical-World Interaction Infrastructure Platform — Master Spec + Claude Code Codebase Audit

---

> **Document purpose:** Step-by-step build plan covering (1) all User/Role/RBAC/Admin provisioning functionality, and (2) the complete Data Sovereignty & Organizer Control layer required for the Indian market. This plan defines what needs to be built, which modules are impacted, the exact sequence of work, the screen + flow specifications absent from the master spec, and the 11 data sovereignty gaps verified against the actual codebase.
>
> **v4 changes:** Part 12 updated with codebase-verified build status from Claude Code audit. 9 sovereignty controls confirmed built. SG3 and SG7 updated from "not built" to "partial build" with precise completion scope. Phase 16 workers updated to reflect existing logic — retention scheduler and DSR worker are completion builds, not greenfield. QA steps 12.53–12.59 updated to reflect codebase reality. Final summary table updated with verified counts.

---

## PART 1 — WHAT EXISTS vs. WHAT IS MISSING

### 1.1 What the Spec Already Defines (Build-Ready)

| Domain | Spec Coverage | Status |
|--------|--------------|--------|
| Role definitions (7 roles) | Sections 3, Appendix A, Part 1 §3 | ✅ Complete |
| `users` schema (fields, status enum) | Part 4 §4.3 | ✅ Complete |
| `roles` schema + required values | Part 4 §4.4 | ✅ Complete |
| `user_role_assignments` (many-to-many) | Part 4 §4.5 | ✅ Complete |
| `organizations` schema (org_type enum) | Part 4 §4.2 | ✅ Complete |
| `tenants` schema | Part 4 §4.1 | ✅ Complete |
| `api_clients` schema | Part 4 §4.6 | ✅ Complete |
| RBAC enforcement middleware stack | Part 3 §3.4–3.8 | ✅ Complete |
| PrincipalContext shape (JWT payload) | Part 3 §3.4 | ✅ Complete |
| Role permissions matrix | Part 1 §5, Appendix A | ✅ Complete |
| Data visibility matrix | Part 1 §6 | ✅ Complete |
| Response masking rules per role | §10.1 | ✅ Complete |
| Event topology (events/halls/stalls schema) | Part 4 §5.1–5.3 | ✅ Complete |
| Event lifecycle status enum | Part 4 §5.1 | ✅ Complete |
| Event data policies | Part 4 §5.4, Appendix D.1 | ✅ Complete |
| Event onboarding checklist (ops runbook) | Part 6 §4.1 | ✅ Complete |

### 1.2 What Is Missing (This Plan Fills These Gaps)

The following gaps were identified across the initial spec review, the first gap analysis response, and this gap-closure audit. All are addressed in this plan.

| # | Gap | Severity | Plan Section |
|---|-----|----------|-------------|
| G1 | No UI screen spec for user creation / invitation | P0 | Part 5, Groups A–B; Part 6 |
| G2 | No API endpoints for user CRUD | P0 | Part 4 §4.3; Phase 3 |
| G3 | No screen spec for RBAC assignment UI | P0 | Part 5, Group D; Phase 8 |
| G4 | No Platform Admin panel screen specs | P0 | Part 5, Group A; Phase 9 |
| G5 | No Organizer-side user management screen | P0 | Part 5, Group B; Phase 10 |
| G6 | No event creation wizard / screen spec | P0 | Part 5, Group C; Phase 10 |
| G7 | No multi-event user scoping UI | P0 | Part 5 §D; Part 7; Phase 11 |
| G8 | No org management screen | P1 | Part 5 §A.3–A.4; Part 5 §A.8 (new) |
| G9 | No user invitation / email flow spec | P0 | Part 6; Phase 6 |
| G10 | No Break-Glass UI screen specs | P0 | Part 5, Group E (new); Phase 9 |
| G11 | No device provisioning / registration UI | P0 | Part 5, Group F (new); Phase 13 (new) |
| G12 | No branding management UI screen specs | P1 | Part 5, Group C §C.2 (updated); Phase 10 |
| G13 | No account settings / password self-service screens | P1 | Part 5, Group G (new); Phase 8 |
| G14 | No API client management UI spec | P1 | Part 5 §A.9 (new); Phase 9 |
| G15 | No standalone org detail screen | P2 | Part 5 §A.8 (new); Phase 9 |
| G16 | Event status transitions incomplete (published→live→closed→archived) | P0 | Part 5 §C.3 (new); Phase 4 (updated) |
| G17 | No stall detail / vendor assignment screen spec | P1 | Part 5 §C.4 (new); Phase 10 |
| G18 | No sponsor package detail screen spec | P1 | Part 5 §C.5 (new); Phase 10 |
| G19 | Organizer vs. Platform Admin authority boundary undefined | P1 | Part 2 §2.8 (new) |
| G20 | QA gaps: break-glass, device, branding, transitions, password reset, API clients | P1 | Phase 12 (updated) |

---

## PART 2 — ROLE RULES AND RESTRICTIONS (COMPLETE REFERENCE)

This section formalises the rules per role. These feed directly into middleware logic, UI visibility, and provisioning constraints.

### 2.1 Platform Admin

**Provisioned by:** System (seed) or another Platform Admin  
**Org type:** `internal`  
**Scope:** Cross-tenant (superuser)  
**Can create:**
- Tenants
- Organizations of any type within a tenant
- Users of any role within a tenant
- Events within a tenant
- API clients

**Cannot:**
- Browse raw attendee PII without an active break-glass session
- Approve their own break-glass request (separate approver required)
- Export raw data without audit trail

**UI visibility:**
- Sees all tenants, all events, all orgs, all users
- All attendee fields are masked by default
- Break-glass button unlocks PII for a time-bounded session

---

### 2.2 Organizer Admin

**Provisioned by:** Platform Admin (during event onboarding)  
**Org type:** `organizer`  
**Scope:** Own tenant + assigned events only  
**Can create/manage:**
- Vendor Manager users (assign to stalls within their event)
- Sponsor User accounts (assign to sponsor packages within their event)
- Ops Users for their event fleet
- Halls, stalls within their event
- Event data policy settings
- Branding profiles
- Export approvals

**Cannot:**
- Create other Organizer Admins (Platform Admin only)
- Access other events in the tenant they don't own
- See other Organizer's events
- Modify platform-level settings
- Access cross-tenant data

**Stall scoping rule:** When creating a Vendor Manager, Organizer Admin must select which stall(s) the vendor is assigned to. This scope is enforced in `user_role_assignments` + event/stall context.

---

### 2.3 Vendor Manager

**Provisioned by:** Organizer Admin  
**Org type:** `vendor`  
**Scope:** Own stall(s) within assigned event only  
**Can:**
- View lead inbox for own stall
- Score and add notes to interactions
- Request export (if `vendor_exports_enabled = true`)
- Connect and push to CRM (if `allow_crm_push = true` and consent given)

**Cannot:**
- See other stalls' leads
- See sponsor analytics
- Change event data policies
- Access organizer fleet view
- Access another event

**Multi-stall rule:** A Vendor Manager may be assigned to multiple stalls (e.g., a vendor with two booths). Each stall assignment is a separate `user_role_assignments` row with stall_id in scope context.

---

### 2.4 Sponsor User

**Provisioned by:** Organizer Admin (linked to a sponsor package)  
**Org type:** `sponsor`  
**Scope:** Own sponsor_package_id within assigned event  
**Can:**
- View sponsor dashboard (impressions, clicks, CTR, opt-in leads)
- View heatmap (aggregated, no PII)
- Request lead export (only if `sponsor_pii_enabled = true` AND consent given)

**Cannot:**
- See vendor lead inbox
- See other sponsors' analytics
- Access organizer controls
- Access any other event unless explicitly assigned

---

### 2.5 Ops User

**Provisioned by:** Platform Admin or Organizer Admin  
**Org type:** `internal` or `organizer`  
**Scope:** Assigned devices / event fleet  
**Can:**
- View fleet health (all devices, heartbeat, incidents)
- Manage device assignments
- View diagnostics
- Log and resolve incidents

**Cannot:**
- Access attendee PII of any kind
- View lead inbox or sponsor analytics
- Approve exports

---

### 2.6 Attendee (No provisioning — self-enrolled via tap)

Created automatically when an NFC tap resolves. No admin creation needed. Attendees are not created by bulk upload.

---

### 2.7 Device Principal (No UI provisioning)

Registered by Ops User via device management workflow. Authenticates via device certificate/token, not password. Out of scope for this plan.

---

### 2.8 Organizer Admin vs. Platform Admin — Authority Boundary (G19)

This boundary was undefined in the original spec and plan. The following table formalises exactly which actions require Platform Admin vs. what an Organizer Admin can self-serve.

| Action | Organizer Admin | Platform Admin |
|--------|----------------|----------------|
| Create event | ✅ Self-service | ✅ Can also do |
| Publish event | ✅ (checklist must pass) | ✅ Can override |
| Create halls / stalls | ✅ | ✅ |
| Create sponsor packages | ✅ | ✅ |
| Set event data policy | ✅ | ✅ |
| Invite Vendor Manager / Sponsor User / Ops User | ✅ | ✅ |
| Invite another Organizer Admin | ❌ | ✅ Only |
| Create organization (new tenant entity) | ❌ | ✅ Only |
| Create a new tenant | ❌ | ✅ Only |
| Create API clients | ❌ | ✅ Only |
| Suspend a user from a different event | ❌ | ✅ Only |
| Request break-glass access | ❌ | ✅ Only |
| Approve break-glass access | ❌ | ✅ Only (second approver, not requester) |
| Access cross-tenant data | ❌ | ✅ (masked by default) |
| Close / archive an event | ✅ Own events | ✅ All events |
| Register / retire a device | ❌ | ✅ Only |
| Assign device to event/stall | ✅ (via Ops User) | ✅ |

**Escalation path:** If an Organizer Admin needs an action only Platform Admin can do (e.g., creating a new org for a late sponsor), the UI must surface a "Request Platform Admin action" prompt with a pre-filled description, which fires a `platform_admin_assistance_request` notification to the Platform Admin team. This is not a blocking modal — the Organizer can continue other tasks while waiting.

---

## PART 3 — ENTITY RELATIONSHIP: USERS, ROLES, EVENTS, VENUES

```
Tenant
 └── Organizations (organizer / vendor / sponsor / internal)
      └── Users
           └── user_role_assignments
                ├── role_id          → roles table
                ├── event_id?        → events (scope limiter)
                └── stall_id?        → stalls (scope limiter for Vendor Manager)

Events (belong to Tenant)
 ├── halls
 │    └── stalls
 │         └── organizations (vendor mapped to stall)
 ├── sponsor_packages
 │    └── organizations (sponsor linked to package)
 ├── device_assignments
 ├── event_data_policies
 └── branding_profiles
```

**Key relationship rules:**
1. A user always belongs to one `organization`. The org type constrains which roles they can hold.
2. A role assignment can be event-scoped (for Organizer Admin, Vendor Manager, Sponsor User) or tenant-wide (for Platform Admin).
3. A Vendor Manager must have at least one stall_id in their scope. An unscoped vendor role is invalid.
4. A Sponsor User must have at least one sponsor_package_id in their scope.
5. An Organizer Admin is scoped to one or more events — not all events in the tenant unless explicitly assigned.
6. Platform Admin has no event/stall scope restriction in the DB, but the UI enforces masked access by default.

---

## PART 4 — NEW API ENDPOINTS REQUIRED

These endpoints do not exist in the current spec and must be added.

### 4.1 Tenant Management (Platform Admin only)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/admin/tenants` | List all tenants |
| POST | `/admin/tenants` | Create new tenant |
| GET | `/admin/tenants/{id}` | Tenant detail |
| PATCH | `/admin/tenants/{id}` | Update tenant (name, slug, status) |

---

### 4.2 Organization Management

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/orgs` | List orgs in tenant | Platform Admin, Organizer Admin |
| POST | `/orgs` | Create org | Platform Admin |
| GET | `/orgs/{id}` | Org detail | Platform Admin, Organizer Admin |
| PATCH | `/orgs/{id}` | Update org | Platform Admin |

---

### 4.3 User Management

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/users` | List users in tenant (scoped) | Platform Admin, Organizer Admin |
| POST | `/users/invite` | Invite new user (sends email) | Platform Admin, Organizer Admin |
| GET | `/users/{id}` | User detail | Platform Admin, Organizer Admin |
| PATCH | `/users/{id}` | Update user (name, status) | Platform Admin, Organizer Admin |
| POST | `/users/{id}/disable` | Disable user | Platform Admin, Organizer Admin |
| POST | `/users/{id}/resend-invite` | Resend invitation | Platform Admin, Organizer Admin |

---

### 4.4 Role Assignment Management

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/users/{id}/roles` | List role assignments for user | Platform Admin, Organizer Admin |
| POST | `/users/{id}/roles` | Assign role (with optional event_id, stall_id, sponsor_package_id) | Platform Admin, Organizer Admin |
| DELETE | `/users/{id}/roles/{assignment_id}` | Remove role assignment | Platform Admin, Organizer Admin |

**Request body for role assignment:**
```json
{
  "role": "vendor_manager",
  "event_id": "uuid",
  "stall_ids": ["uuid", "uuid"]
}
```

**Validation rules:**
- `vendor_manager` requires `event_id` + at least one `stall_id`
- `sponsor_user` requires `event_id` + `sponsor_package_id`
- `organizer_admin` requires at least one `event_id`
- `ops_user` requires `event_id`
- `platform_admin` requires no event/stall scope

---

### 4.5 Event Management (Admin/Organizer)

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| POST | `/events` | Create event | Platform Admin, Organizer Admin |
| GET | `/events` | List events (tenant-scoped) | Platform Admin, Organizer Admin |
| PATCH | `/events/{id}` | Update event details | Platform Admin, Organizer Admin |
| POST | `/events/{id}/publish` | Move from draft → published | Organizer Admin |
| POST | `/events/{id}/go-live` | Move from published → live | Organizer Admin, Platform Admin |
| POST | `/events/{id}/close` | Move from live → closed | Organizer Admin, Platform Admin |
| POST | `/events/{id}/archive` | Move from closed → archived | Platform Admin only |
| GET | `/events/{id}/checklist` | Onboarding checklist status | Organizer Admin |
| POST | `/events/{id}/halls` | Create hall | Organizer Admin |
| PATCH | `/halls/{id}` | Update hall | Organizer Admin |
| DELETE | `/halls/{id}` | Delete hall (draft only) | Organizer Admin |
| POST | `/events/{id}/stalls` | Create stall | Organizer Admin |
| PATCH | `/stalls/{id}` | Update stall / assign org | Organizer Admin |
| DELETE | `/stalls/{id}` | Delete stall (draft only) | Organizer Admin |
| POST | `/events/{id}/sponsor-packages` | Create sponsor package | Organizer Admin |
| PATCH | `/sponsor-packages/{id}` | Update package | Organizer Admin |
| POST | `/events/{id}/data-policy` | Set/update data policy | Organizer Admin |

---

### 4.6 Break-Glass Access (Platform Admin only) — G10

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/admin/break-glass/request` | Submit break-glass request with justification + scope |
| GET | `/admin/break-glass` | List all break-glass requests (tenant-scoped) |
| POST | `/admin/break-glass/{id}/approve` | Approve request (approver ≠ requester) |
| POST | `/admin/break-glass/{id}/reject` | Reject with reason |
| POST | `/admin/break-glass/{id}/revoke` | Early revoke active session |
| GET | `/admin/break-glass/{id}` | Detail of a single request |

**Request body for POST /admin/break-glass/request:**
```json
{
  "justification": "string (required, min 20 chars)",
  "access_scope": "interaction_pii | attendee_pii | export_review | incident_debug",
  "event_id": "uuid (optional)",
  "requested_duration_minutes": 60
}
```
**Max approved duration:** 240 minutes (4 hours). Requestor and approver must be different users.

---

### 4.7 Device Provisioning (Platform Admin + Ops User) — G11

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/devices` | List all devices (tenant-scoped, filterable by status) | Platform Admin, Ops User |
| POST | `/devices` | Register new device to inventory | Platform Admin |
| GET | `/devices/{id}` | Device detail | Platform Admin, Ops User |
| PATCH | `/devices/{id}` | Update device (name, status) | Platform Admin, Ops User |
| POST | `/devices/{id}/assign` | Assign device to event + stall | Ops User, Platform Admin |
| POST | `/devices/{id}/unassign` | Unassign device from event | Ops User, Platform Admin |
| POST | `/devices/{id}/retire` | Retire device permanently | Platform Admin |
| POST | `/nfc-readers` | Register NFC reader, pair to device | Ops User |
| PATCH | `/nfc-readers/{id}` | Update reader firmware/status | Ops User |

---

### 4.8 Branding Management — G12

The branding API surface already exists in the spec (§6.5.1–6.5.4). These new endpoints complement the existing ones for the admin UI:

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/events/{id}/branding` | Fetch branding profile (existing) | Organizer Admin |
| POST | `/events/{id}/branding` | Create/update branding profile (existing) | Organizer Admin |
| POST | `/branding/assets` | Upload asset (existing) | Organizer Admin |
| POST | `/branding/publish` | Publish to fleet (existing) | Organizer Admin, Platform Admin |
| GET | `/events/{id}/branding/status` | Branding approval/publish status | Organizer Admin |
| POST | `/events/{id}/branding/approve` | Mark branding as approved | Organizer Admin (self-approve after review) |

---

### 4.9 Auth Self-Service — G13

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/auth/forgot-password` | Request password reset (sends email with token) |
| POST | `/auth/reset-password` | Submit new password using reset token |
| POST | `/auth/change-password` | Change password for authenticated user |
| GET | `/auth/me` | Get current user profile |
| PATCH | `/auth/me` | Update own full_name |

---

### 4.10 API Client Management — G14

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/admin/api-clients` | List API clients (tenant-scoped) | Platform Admin |
| POST | `/admin/api-clients` | Create new API client | Platform Admin |
| GET | `/admin/api-clients/{id}` | API client detail | Platform Admin |
| POST | `/admin/api-clients/{id}/rotate-secret` | Rotate client secret (old invalidated immediately) | Platform Admin |
| POST | `/admin/api-clients/{id}/revoke` | Revoke / disable client | Platform Admin |

---

## PART 5 — SCREEN SPECIFICATIONS (NEW — NOT IN CURRENT SPEC)

### SCREEN GROUP A: PLATFORM ADMIN PANEL

---

#### A.1 — Admin: Tenant List Screen

**Route:** `/admin/tenants`  
**Access:** Platform Admin only  
**Purpose:** Top-level view of all tenants on the platform.

**Layout:** Full-width table

**Table columns:**
- Tenant Name
- Slug
- Created At
- Orgs (count)
- Users (count)
- Active Events (count)
- Status (active / suspended)
- Actions: [View] [Suspend]

**Actions available:**
- [+ New Tenant] button → opens A.2 Create Tenant modal
- Click row → navigates to A.3 Tenant Detail

**States:** loading / empty ("No tenants yet") / error

---

#### A.2 — Admin: Create Tenant Modal

**Trigger:** [+ New Tenant] from A.1  
**Type:** Modal overlay

**Fields:**
- Tenant Name (text, required)
- Slug (auto-generated from name, editable, unique-validated)

**Submit behaviour:**
- POST `/admin/tenants`
- On success: close modal, refresh list, show success toast
- On slug conflict: inline error "Slug already in use"

---

#### A.3 — Admin: Tenant Detail Screen

**Route:** `/admin/tenants/{id}`  
**Tabs:** Overview | Organizations | Users | Events | API Clients | Audit Log

**Overview tab:**
- Tenant name, slug, created date
- Stats: total orgs, total users, total events, active interactions (last 30d)
- [Edit Tenant] → inline edit name/slug
- [Suspend Tenant] → confirmation modal

**Organizations tab:**
- Table: Name, Org Type, Users (count), Created At, Actions: [View] [Edit]
- [+ New Organization] → A.4 Create Org modal

**Users tab:**
- Table: Full Name, Email, Org, Role(s), Status, Last Login, Actions: [View] [Disable] [Resend Invite]
- [+ Invite User] → A.5 Invite User flow
- Filter: by org, by role, by status

**Events tab:**
- Table: Event Name, Venue, Dates, Status, Stalls (count), Devices (count)
- [+ Create Event] → A.6 Create Event wizard

**API Clients tab:**
- Table: Client Name, Scopes, Created At, Actions: [Revoke]
- [+ New API Client]

**Audit Log tab:**
- Table: Timestamp, Actor, Action, Target, IP
- Filter by date range and action type

---

#### A.4 — Admin: Create Organization Modal

**Fields:**
- Organization Name (required)
- Org Type (select: organizer / sponsor / vendor / internal)
- Tenant (pre-filled if in tenant context)

**Submit:** POST `/orgs`

---

#### A.5 — Admin: Invite User Flow

**Trigger:** [+ Invite User] from Tenant Detail > Users tab  
**Type:** Multi-step modal (2 steps)

**Step 1 — User Details:**
- Full Name (required)
- Email (required, validated, unique)
- Organization (select from orgs in tenant, required)

**Step 2 — Role Assignment:**
- Role (select): platform_admin / organizer_admin / vendor_manager / sponsor_user / ops_user
- **Conditional fields based on role:**
  - If `organizer_admin`: multi-select Events
  - If `vendor_manager`: select Event → then multi-select Stalls within that event
  - If `sponsor_user`: select Event → then select Sponsor Package
  - If `ops_user`: select Event
  - If `platform_admin`: no scoping needed

**Submit behaviour:**
- POST `/users/invite` → creates user with `status: invited`
- POST `/users/{id}/roles` → creates role assignment
- System sends invitation email with set-password link (expires 72h)
- On success: close modal, toast "Invitation sent to user@email.com"

**Error states:**
- Email already in use: inline error
- No stall selected for vendor_manager: inline error "At least one stall is required"

---

#### A.6 — Admin: Create Event Wizard

**Route:** `/admin/tenants/{id}/events/new`  
**Type:** Multi-step wizard (4 steps)

**Step 1 — Event Basics:**
- Event Name (required)
- Venue Name (required)
- City (required)
- Country (select)
- Start Date (required)
- End Date (required)
- Status: defaults to `draft`

**Step 2 — Halls & Stalls:**
- Add halls (name, optional floor map upload)
- For each hall: add stalls (stall_code, stall_name, assign to organization or leave unbound)
- [+ Add Hall] [+ Add Stall to Hall] controls
- Or: [Upload CSV] for bulk stall import

**Step 3 — Sponsor Packages:**
- [+ Add Sponsor Package] rows
  - Package Name
  - Linked Organization (sponsor type)
  - Package tier (Bronze / Silver / Gold / custom)

**Step 4 — Data Policy:**
- vendor_exports_enabled (toggle, default ON)
- sponsor_pii_enabled (toggle, default OFF)
- require_export_approval (toggle, default OFF)
- allow_crm_push (toggle, default ON)
- retention_days (select: 30 / 60 / 90 / 180 / 365, default 90)
- allow_cross_event_identity_graph (toggle, default OFF)

**Review + Submit:**
- Summary of all entries
- [Create Event] → POST `/events` + POST halls + POST stalls + POST data-policy
- On success: redirect to Event Detail screen
- On failure: return to failing step with error

---

#### A.7 — Admin: User Detail Screen

**Route:** `/admin/users/{id}`  
**Sections:**

**Profile section:**
- Full name (editable inline)
- Email (read-only after invite)
- Organization (read-only)
- Status badge (active / invited / disabled) + [Disable Account] or [Re-enable] action
- Created At, Last Login

**Role Assignments section:**
- Table: Role | Scope (Event name + Stall/Package if applicable) | Assigned At | Actions: [Remove]
- [+ Assign Role] → opens role assignment modal (same as Step 2 in A.5)

**Activity section:**
- Recent audit log entries for this user (last 20 actions)

---

### SCREEN GROUP B: ORGANIZER ADMIN — USER MANAGEMENT

---

#### B.1 — Organizer: Team Management Screen

**Route:** `/organizer/team`  
**Access:** Organizer Admin only  
**Scope:** Users within their event(s) only  

**Layout:** Two-panel
- Left: filter sidebar (by role, by event, by status)
- Right: user table

**Table columns:**
- Full Name
- Email
- Role
- Assigned Event
- Stall / Package (if applicable)
- Status
- Actions: [View] [Edit Role] [Disable] [Resend Invite]

**Actions:**
- [+ Invite Team Member] → B.2 Invite User flow (Organizer-scoped)
- Click user row → B.3 User Detail (Organizer view)

---

#### B.2 — Organizer: Invite Team Member Flow

**Type:** Modal (2 steps, same pattern as A.5 but scope-limited)

**Step 1 — User Details:**
- Full Name, Email, Organization (pre-filtered to orgs within organizer's events)

**Step 2 — Role + Scope:**
- Role (limited to: vendor_manager / sponsor_user / ops_user — Organizer cannot create other Organizer Admins)
- Event: pre-selected if organizer manages one event; dropdown if multiple
- Stall (if vendor_manager)
- Sponsor Package (if sponsor_user)

**Validation:** Same as A.5

---

#### B.3 — Organizer: Team Member Detail

**Route:** `/organizer/team/{user_id}`

**Sections:**
- Profile (name, email, status, org)
- Role & Scope (current assignment, event, stall/package)
- [Edit Scope] → can change stall assignment or event within organizer's scope
- [Remove from Event] → removes role assignment for this event
- [Disable Account] → sets user status = disabled

---

### SCREEN GROUP C: EVENT MANAGEMENT (ORGANIZER VIEW)

---

#### C.1 — Organizer: Event List Screen

**Route:** `/organizer/events`  
**Shows:** Only events the Organizer Admin is assigned to

**Table:** Event Name, Venue, Dates, Status pill, Stalls (count), Devices (count), [Manage] button  
**[+ Create Event]** → opens simplified event wizard (same as A.6 but pre-scoped to organizer's tenant)

---

#### C.2 — Organizer: Event Detail Screen

**Route:** `/organizer/events/{id}`  
**Tabs:** Overview | Halls & Stalls | Sponsor Packages | Branding | Data Policy | Team | Devices | Audit

**Overview tab:**
- Event name, venue, dates, status badge
- Status-conditional action buttons:
  - Status = `draft`: [Publish Event] (checklist must pass) → POST `/events/{id}/publish`
  - Status = `published`: [Go Live] → J.1 Go Live Confirmation Modal
  - Status = `live`: [Close Event] → J.2 Close Event Confirmation Modal
  - Status = `closed`: [Archive Event] (Platform Admin only) → J.3 Archive Confirmation Modal
- Onboarding checklist widget:
  - ✅/❌ Event details entered
  - ✅/❌ At least one hall added
  - ✅/❌ Stalls loaded
  - ✅/❌ Organizer org linked
  - ✅/❌ Sponsor packages defined
  - ✅/❌ Data policy set
  - ✅/❌ Organizer admin user created
  - ✅/❌ Branding approved

**Halls & Stalls tab:**
- Hall list with stall counts
- Expand hall → stall table (code, name, linked org, device count)
- [+ Add Hall] [+ Add Stall] [Edit] [Delete] (only in draft status)
- Stall row → click to open I.2 Stall Detail Screen

**Sponsor Packages tab:**
- Table: Package Name, Sponsor Org, Tier, Users (count), Status
- [+ Add Package]
- Click package → I.3 Sponsor Package Detail Screen

**Branding tab:**
- See Screen Group K (K.1 Event Branding Tab) — full spec defined there

**Data Policy tab:**
- All 6 policy toggles (read the current values from `event_data_policies`)
- [Save Policy] — only Organizer Admin can change; all changes are audited
- Warning banners: e.g., "Sponsor PII is currently enabled — sponsors may access consented lead data"

**Team tab:**
- Embedded B.1 scoped to this event

**Devices tab:**
- Fleet table (from existing organizer fleet spec)
- Device assignments, heartbeat, battery, queue depth

**Audit tab:**
- Audit log filtered to this event's actions

---

### SCREEN GROUP D: SHARED — ROLE ASSIGNMENT MODAL

Used in multiple contexts (A.5, A.7, B.2, B.3, stall detail).

**Component name:** `RoleAssignmentModal`

**Props:**
- `userId` (pre-filled or empty)
- `tenantId`
- `allowedRoles` (list — Platform Admin sees all; Organizer Admin sees vendor_manager, sponsor_user, ops_user)
- `eventOptions` (list of events in scope)

**Behaviour:**
1. Select Role → shows/hides conditional scope fields
2. `organizer_admin`: multi-select events
3. `vendor_manager`: select event → stalls lazy-load → multi-select stalls
4. `sponsor_user`: select event → sponsor packages lazy-load → select package
5. `ops_user`: select event
6. `platform_admin`: no scope fields shown

**Validation:**
- vendor_manager without stall → blocked ("At least one stall required")
- sponsor_user without package → blocked ("Sponsor package required")
- Duplicate assignment (same role + same scope already exists) → warning, allow override with confirmation

**On submit:** POST `/users/{id}/roles`

---

### SCREEN GROUP E: BREAK-GLASS ACCESS — G10

All screens in this group are Platform Admin only. Break-glass is the mandatory mechanism for Platform Admins to access unmasked attendee PII and is a core trust-model requirement.

---

#### E.1 — Break-Glass: Request Access Screen

**Route:** `/admin/break-glass/new`  
**Access:** Platform Admin only  
**Purpose:** Submit a time-bounded privileged access request that a second Platform Admin must approve.

**Fields:**
- Justification (textarea, required, min 20 characters — enforced) — free-text explanation of why access is needed
- Access Scope (select, required):
  - `interaction_pii` — Unmasked interaction + attendee data
  - `attendee_pii` — Full attendee profile vault
  - `export_review` — Review a flagged export queue item
  - `incident_debug` — Debug a specific device or data incident
- Event (optional select — pre-fills from user's assigned events or all events if platform admin)
- Requested Duration (select: 30 min / 60 min / 120 min / 240 min)

**Submit:** POST `/admin/break-glass/request`

**Behaviour:**
- On submit: request created with `status: requested`
- Toast: "Break-glass request submitted. A second Platform Admin must approve."
- Page redirects to E.3 Break-Glass History — request appears at top with `pending` badge
- A notification is fired to all other active Platform Admins

**Validation:**
- Requester cannot be approver — UI hides the request from the submitter's approval queue
- Justification under 20 characters → inline error

---

#### E.2 — Break-Glass: Approve / Reject Screen

**Route:** `/admin/break-glass/{id}/review`  
**Access:** Platform Admin who is NOT the requester  
**Purpose:** Second approver reviews and approves or rejects a pending break-glass request.

**Display:**
- Requester name and email
- Justification (full text)
- Access scope
- Requested event (if any)
- Requested duration
- Submitted at timestamp

**Actions:**
- [Approve Access] — confirms approval, sets `starts_at = now()`, `expires_at = now() + duration`, `status = approved`
- [Reject] — requires rejection reason (required textarea), sets `status = rejected`

**Constraints:**
- Approve button is disabled if the logged-in user is the requester (server also enforces this)
- [Approve Access] shows a confirmation dialog: "You are granting unmasked PII access to [Requester Name] until [time]. This action is permanent and audited."

**Behaviour after approval:**
- Requester's UI immediately updates — masked fields unlock in their session
- Active break-glass banner appears in requester's header (E.3)
- Audit event `break_glass.approved` fires

---

#### E.3 — Break-Glass: Active Session Banner (Global Component)

**Type:** Persistent header banner (component, not a page)  
**Appears on:** All admin screens when a Platform Admin has an active approved break-glass session  
**Purpose:** Constant reminder that elevated access is active; one-click revocation.

**Content:**
- 🔴 "Break-glass session active — [access_scope] — expires in [countdown timer]"
- [Revoke Now] button → confirmation dialog → POST `/admin/break-glass/{id}/revoke`
- On expiry: banner disappears, all fields re-mask automatically without page reload (re-mask triggered client-side on `expires_at`)

---

#### E.4 — Break-Glass: History Screen

**Route:** `/admin/break-glass`  
**Access:** Platform Admin only  
**Purpose:** Full audit trail of all break-glass requests for the tenant.

**Table columns:**
- Requested At
- Requester
- Scope
- Event (if applicable)
- Justification (truncated, click to expand)
- Status badge (requested / approved / rejected / expired / revoked)
- Approved By
- Duration / Expires At
- Actions: [View Detail] [Revoke] (only if status = approved and not expired)

**Filters:** Status, Requester, Date range, Scope  
**Default sort:** Most recent first

---

### SCREEN GROUP F: DEVICE PROVISIONING — G11

Device provisioning is split between Platform Admin (register/retire devices) and Ops User (assign to events/stalls). These screens integrate with the existing Ops fleet view.

---

#### F.1 — Admin: Device Inventory Screen

**Route:** `/admin/devices`  
**Access:** Platform Admin only  
**Purpose:** Platform-level view of all registered kiosk hardware across the tenant.

**Table columns:**
- Serial Number
- Device Name
- Hardware Type (industrial_kiosk / tablet_kiosk)
- App Version
- Status pill (inventory / assigned / live / repair / retired)
- Assigned Event (if applicable)
- Assigned Stall (if applicable)
- Last Heartbeat
- Actions: [View] [Edit] [Retire]

**Actions:**
- [+ Register Device] → F.2 Register Device modal
- Status filter: all / inventory / assigned / live / repair / retired
- Click row → F.3 Device Detail

---

#### F.2 — Admin: Register Device Modal

**Trigger:** [+ Register Device] from F.1  
**Type:** Modal

**Fields:**
- Serial Number (required, must be unique — validated on blur)
- Device Name (required, human-readable label e.g. "Kiosk-Hall-A-01")
- Hardware Type (select: industrial_kiosk / tablet_kiosk)
- Tenant (pre-filled)

**Submit:** POST `/devices`  
**On success:** Device created with `status: inventory`. Toast: "Device registered. Assign it to an event via the Ops fleet screen."

---

#### F.3 — Admin / Ops: Device Detail Screen

**Route:** `/admin/devices/{id}` (Platform Admin) | `/ops/devices/{id}` (Ops User)  
**Access:** Platform Admin sees full detail; Ops User sees assignment + health only (no retire/edit)

**Sections:**

**Identity section:**
- Serial number, device name, hardware type, app version
- Status badge + [Edit] (Platform Admin only)
- [Retire Device] → confirmation modal (Platform Admin only, only allowed if status ≠ live)

**Assignment section:**
- Current event assignment (if any): Event name, Stall name, Starts At, Ends At
- [Assign to Event] → F.4 Assign Device modal (Ops User or Platform Admin)
- [Unassign] → confirmation modal (only if status = assigned, not live)

**NFC Reader section:**
- Paired reader (model, firmware version, status)
- [Pair NFC Reader] → F.5 Pair Reader modal
- [Update Firmware Version] → inline edit

**Health section:**
- Last heartbeat timestamp
- Battery %
- Queue depth
- App version
- [Force Sync] [Refresh Config] [Restart Adapter] (Ops User + Platform Admin)

**Incident Log:**
- Recent incidents (type, severity, created_at, resolved_at)

---

#### F.4 — Ops: Assign Device to Event/Stall Modal

**Trigger:** [Assign to Event] from F.3  
**Access:** Ops User, Platform Admin  
**Type:** Modal

**Fields:**
- Event (select — Ops User sees their assigned event(s); Platform Admin sees all)
- Stall (select — lazy-loads stalls for selected event, filtered to unoccupied)
- Starts At (datetime, defaults to event start_at)
- Ends At (datetime, defaults to event end_at)

**Submit:** POST `/devices/{id}/assign`  
**On success:** Device status changes to `assigned`. Toast: "Device assigned to [Stall Name] at [Event Name]."

**Validation:**
- Cannot assign a device already `live` on another event
- Stall cannot have more than one active device assignment (unique constraint)

---

#### F.5 — Ops: Pair NFC Reader Modal

**Type:** Modal  
**Fields:**
- NFC Reader Model (default ACR122U, editable)
- Firmware Version (text)

**Submit:** POST `/nfc-readers`  
**On success:** Reader record created, paired to device.

---

### SCREEN GROUP G: ACCOUNT SETTINGS & SELF-SERVICE — G13

These screens apply to all authenticated users regardless of role.

---

#### G.1 — My Account Screen

**Route:** `/account`  
**Access:** All authenticated users  
**Purpose:** View and update own profile, change password.

**Sections:**

**Profile section:**
- Full Name (editable, PATCH `/auth/me`)
- Email (read-only — email changes require Platform Admin)
- Organization name (read-only)
- Role(s) + assigned event(s) (read-only, informational)
- Status badge

**Password section:**
- [Change Password] → G.2 Change Password modal

**Session section:**
- Last login timestamp
- Current session started at
- [Sign Out All Sessions] (terminates all active refresh tokens for this user)

---

#### G.2 — Change Password Modal

**Trigger:** [Change Password] from G.1  
**Type:** Modal

**Fields:**
- Current Password (required)
- New Password (required, min 10 chars, 1 uppercase, 1 number)
- Confirm New Password (must match)

**Submit:** POST `/auth/change-password`  
**On success:** Toast "Password updated. You may be signed out of other sessions."  
**On error — wrong current password:** Inline error "Current password is incorrect"

---

#### G.3 — Forgot Password Screen

**Route:** `/auth/forgot-password` (public, no auth required)  
**Purpose:** Initiate password reset for users who cannot log in.

**Fields:**
- Email address (required)

**Submit:** POST `/auth/forgot-password`  
**Behaviour:**
- Always shows: "If an account exists for this email, a reset link has been sent." (prevents email enumeration)
- Reset email sent with signed token, expires 1 hour
- Token is single-use

---

#### G.4 — Reset Password Screen

**Route:** `/auth/reset-password?token={token}` (public, no auth required)  
**Purpose:** Set a new password using the reset token from email.

**Fields:**
- New Password (required, same complexity rules as invite)
- Confirm Password

**Submit:** POST `/auth/reset-password` (token passed in body, not just URL)  
**On success:** "Password reset successfully. Redirecting to login…" → redirect to `/login` after 3 seconds  
**On expired/invalid token:** Error screen: "This reset link has expired or is invalid. Request a new one." with link back to G.3  

---

### SCREEN GROUP H: API CLIENT MANAGEMENT — G14

---

#### H.1 — Admin: API Clients Screen

**Route:** `/admin/tenants/{id}` (API Clients tab — already in A.3)  
**Access:** Platform Admin only

**Table columns:**
- Client Name
- Client ID (truncated UUID)
- Scopes (comma-separated list)
- Status (active / revoked)
- Created At
- Last Used At
- Actions: [View] [Rotate Secret] [Revoke]

**Actions:**
- [+ New API Client] → H.2 Create API Client modal
- Click row → H.3 API Client Detail

---

#### H.2 — Create API Client Modal

**Fields:**
- Client Name (required, descriptive — e.g. "Salesforce Integration")
- Allowed Scopes (multi-select checkboxes):
  - `interactions:read`
  - `leads:export`
  - `events:read`
  - `webhooks:write`
  - `analytics:read`

**Submit:** POST `/admin/api-clients`  
**On success:** Modal transitions to show the generated `client_id` and `client_secret`. Warning banner: "Copy the secret now — it will never be shown again." [Copy to Clipboard] button. [Done] closes modal.

---

#### H.3 — API Client Detail Screen

**Route:** `/admin/api-clients/{id}`

**Sections:**

**Identity section:**
- Client Name (editable inline)
- Client ID (read-only, with [Copy] button)
- Scopes (read-only list)
- Status badge
- Created At, Last Used At

**Secret section:**
- Secret: `••••••••••` (never displayed again after creation)
- [Rotate Secret] → confirmation dialog ("Rotating will immediately invalidate the current secret. Any integration using it will break until updated.") → POST `/admin/api-clients/{id}/rotate-secret` → same one-time display flow as creation

**Danger section:**
- [Revoke Client] → confirmation → POST `/admin/api-clients/{id}/revoke` → status becomes `revoked`, all API calls with this key return 401 immediately

---

### SCREEN GROUP I: ORG DETAIL & STALL/PACKAGE SCREENS — G15, G17, G18

---

#### I.1 — Admin: Organization Detail Screen — G15

**Route:** `/admin/orgs/{id}`  
**Access:** Platform Admin (full); Organizer Admin (read-only for orgs within their events)

**Sections:**

**Profile section:**
- Org Name (editable, Platform Admin only)
- Org Type badge (organizer / vendor / sponsor / internal — read-only after creation)
- Tenant
- Created At
- [Edit Org Name] inline (Platform Admin only)

**Users section:**
- Table: Full Name, Email, Role(s), Status, Actions: [View User]
- [+ Invite User to Org] → pre-fills org in A.5 invite flow

**Events section:**
- For organizer orgs: events they manage
- For vendor orgs: stall assignments (Event Name, Stall Code, Stall Name)
- For sponsor orgs: sponsor packages (Event Name, Package Name, Tier)

**CRM Connections section:**
- Table: Provider (Salesforce/HubSpot/Zoho), Status, Created At, Actions: [Disconnect]
- [+ Connect CRM] → vendor CRM settings flow (existing spec)

---

#### I.2 — Organizer: Stall Detail Screen — G17

**Route:** `/organizer/events/{event_id}/stalls/{stall_id}`  
**Access:** Organizer Admin  
**Purpose:** Manage a single stall — assign vendor org, link vendor manager users, view current device.

**Sections:**

**Stall Identity:**
- Stall Code (read-only)
- Stall Name (editable inline)
- Hall (select — change hall assignment, only in draft/published status)
- Linked Vendor Organization (select from vendor orgs in tenant, or "Unassigned")

**Vendor Manager Users:**
- Table: Full Name, Email, Status, Actions: [Remove from Stall]
- [+ Assign Vendor Manager] → opens RoleAssignmentModal pre-filled with this stall, vendor_manager role
- Note: This also links the user's `user_role_assignments.stall_ids` to include this stall

**Device Assignment:**
- Current device (if any): Device Name, Serial Number, Status, Last Heartbeat
- [Change Device] → F.4 Assign Device modal
- [Unassign Device] (only if status ≠ live)

**Activity:**
- Total interactions at this stall (count)
- Most recent interaction timestamp
- Lead inbox link: [View Leads →] (links to vendor lead inbox filtered to this stall)

**Status guards:**
- Stall Name / Hall / Vendor Org are editable only when event status is `draft` or `published`
- Fields become read-only when event is `live` — a warning banner shows: "Event is live. Stall configuration is locked."

---

#### I.3 — Organizer: Sponsor Package Detail Screen — G18

**Route:** `/organizer/events/{event_id}/sponsor-packages/{package_id}`  
**Access:** Organizer Admin  
**Purpose:** Manage a sponsor package — update tier, link sponsor org, manage sponsor users.

**Sections:**

**Package Identity:**
- Package Name (editable inline)
- Tier (select: Bronze / Silver / Gold / Custom — editable)
- Linked Sponsor Organization (select from sponsor orgs in tenant)

**Sponsor Users:**
- Table: Full Name, Email, Status, Actions: [Remove from Package]
- [+ Assign Sponsor User] → opens RoleAssignmentModal pre-filled with this package, sponsor_user role

**Package Entitlements (display only — driven by data policy):**
- Sponsor PII enabled: ✅/❌ (links to Data Policy tab)
- Heatmap access: ✅ (always)
- Impressions/clicks analytics: ✅ (always)
- Export allowed: ✅/❌ (based on `sponsor_pii_enabled`)

**Branding Contribution:**
- Sponsor logo URL (read-only, shown from branding profile)
- [View Branding →] links to Branding tab in C.2

---

### SCREEN GROUP J: EVENT STATUS TRANSITIONS — G16

These are action screens/confirmations triggered from C.2 Event Detail screen. They enforce transition guards defined in the master spec.

---

#### J.1 — Go Live Confirmation Modal

**Trigger:** [Go Live] button on C.2 Event Detail screen (only shown when status = `published`)  
**Type:** Modal

**Display:**
- Event name, start date, venue
- Checklist confirmation (all items must be ✅):
  - Devices assigned and heartbeating
  - Branding published to fleet
  - All stalls have device assignments
  - Data policy confirmed

**Action:** [Confirm — Go Live] → POST `/events/{id}/go-live`  
**On success:** Event status changes to `live`. All connected kiosks begin accepting taps. Toast: "Event is now live. Tap ingestion is active."  
**On failure (checklist incomplete):** Modal lists blocking items. [Go Live] button stays disabled.

---

#### J.2 — Close Event Confirmation Modal

**Trigger:** [Close Event] button on C.2 (only shown when status = `live`)  
**Type:** Modal with impact warning

**Display:**
- Warning: "Closing this event will stop all tap ingestion immediately. This cannot be undone without Platform Admin intervention."
- Event name, live duration, total interactions count
- Confirm by typing event name in a text field (safety UX)

**Action:** [Close Event] → POST `/events/{id}/close`  
**On success:** Status → `closed`. All devices receive config update stopping tap processing. Toast: "Event closed. No new interactions will be accepted."

---

#### J.3 — Archive Event Confirmation Modal

**Trigger:** [Archive Event] button (Platform Admin only, shown when status = `closed`)  
**Type:** Modal

**Display:**
- "Archiving marks this event as historical. Users with event scope will lose dashboard access."
- Retention policy reminder: "Data will be retained for [retention_days] days then purged per policy."

**Action:** [Archive] → POST `/events/{id}/archive` (Platform Admin only)  
**On success:** Status → `archived`. Organizer Admin dashboard no longer shows this event by default (accessible via "Show archived" filter).

---

### SCREEN GROUP K: BRANDING MANAGEMENT — G12

This extends C.2 (Event Detail) with a full Branding tab spec, previously absent.

---

#### K.1 — Event Branding Tab (within C.2)

**Route:** `/organizer/events/{id}` → Branding tab  
**Access:** Organizer Admin  
**Purpose:** Upload, preview, and publish sponsor/event branding to the kiosk fleet.

**Sections:**

**Current Branding Profile:**
- Sponsor Logo (image preview, [Replace] button)
- Sponsor CTA Text (editable text, max 80 chars)
- Sponsor Redirect URL (editable URL, validated)
- Idle Screen Message (editable text, max 120 chars)
- Active Sidebar Message (editable text, max 120 chars)
- QR Fallback URL (editable URL)

**Asset Upload:**
- [Upload Sponsor Logo] → file picker (PNG/SVG/JPEG only, max 2MB)
  - POST `/branding/assets` — signed upload flow
  - On upload success: preview renders inline
- [Upload Event Logo] → same flow

**Status bar:**
- Last saved: [timestamp]
- Publish status: `Unpublished changes` / `Published` / `Publishing...`
- [Save Draft] → POST `/events/{id}/branding`
- [Preview on Kiosk] → opens a kiosk simulation modal (renders the idle screen with current branding values)
- [Publish to Fleet] → J.4 Publish Branding Confirmation modal

**Branding Approval:**
- Approval status badge: `Draft` / `Approved` / `Published`
- [Mark as Approved] (self-approval by Organizer Admin) → POST `/events/{id}/branding/approve`
- Note displayed: "Publishing requires branding to be marked as approved first."
- Publish button is disabled until `approved` status

---

#### K.2 — Publish Branding Confirmation Modal — G12

**Trigger:** [Publish to Fleet] from K.1  
**Type:** Modal

**Display:**
- "This will push the current branding to [N] assigned devices."
- Preview thumbnail of sponsor logo and idle screen message
- Warning if event is not yet `live`: "Event is not live yet. Devices will cache branding and apply it when the event goes live."

**Action:** [Confirm Publish] → POST `/branding/publish`  
**On success:** Toast "Branding published to [N] devices." Publish status updates to `Published`.  
**On failure (some devices unreachable):** Toast "Published to [X] of [N] devices. [Y] devices will receive update on next config poll."

---

## PART 6 — USER INVITATION LIFECYCLE

```
Platform Admin / Organizer Admin clicks [+ Invite User]
         ↓
User record created (status: invited, password: null)
         ↓
Role assignment created (scoped)
         ↓
Invitation email sent (signed token, expires 72h)
         ↓
User clicks link → Set Password screen
         ↓
Password set → status changes to: active
         ↓
User logs in → JWT issued with PrincipalContext (roles, event_ids, stall_ids)
         ↓
Redirected to role-appropriate dashboard
         ↓ (if invite not accepted in 72h)
Admin can [Resend Invite] → new signed token, old token invalidated
```

**Set Password screen fields:**
- Full name (pre-filled, read-only)
- Email (pre-filled, read-only)
- Password (min 10 chars, 1 uppercase, 1 number)
- Confirm Password
- [Activate Account]

---

## PART 7 — POST-LOGIN ROUTING BY ROLE

After successful authentication, route user based on primary role:

| Role | Redirect target |
|------|----------------|
| platform_admin | `/admin/tenants` |
| organizer_admin | `/organizer/events` (if 1 event) or event picker if multiple |
| vendor_manager | `/vendor/inbox` (stall pre-selected) |
| sponsor_user | `/sponsor/overview` |
| ops_user | `/ops/fleet` |

If a user has multiple role assignments (e.g., Vendor Manager for two events), show a **context picker** before routing:
- "Which event are you working today?" → select → store in session context → route

---

## PART 8 — IMPACT ANALYSIS: MODULES AFFECTED

### 8.1 Auth Service
**Impact: HIGH**

Currently handles JWT validation and role mapping. Must be extended to:
- Issue JWTs with `event_ids[]` and `stall_ids[]` populated from `user_role_assignments`
- Handle invite token validation (separate token type, short-lived)
- Handle set-password flow (currently undefined)
- Session context switching for multi-role users

**New work required:**
- Invite token issuance + validation
- Set-password endpoint
- JWT payload extension for event/stall scope arrays
- Post-login redirect resolver

---

### 8.2 Middleware Stack (roleScopeMiddleware)
**Impact: HIGH**

Currently enforces role eligibility at route level. Must be extended to:
- Validate `event_id` in request path/params against `event_ids[]` in PrincipalContext
- Validate `stall_id` against `stall_ids[]` in PrincipalContext
- Validate `sponsor_package_id` for Sponsor User routes

**New work required:**
- Add event_id scope check per route (currently assumed, not explicitly coded)
- Add stall_id scope check per route
- Add sponsor_package_id scope check

---

### 8.3 Event Service
**Impact: HIGH**

Currently handles event read operations. Must be extended to:
- Full event CRUD (create, update, status transitions)
- Hall CRUD
- Stall CRUD (including org assignment, stall-to-vendor-user linking)
- Sponsor package CRUD
- Event data policy write operations
- Onboarding checklist state computation

**New work required:**
- POST/PATCH `/events` handler
- Status transition guards (draft → published requires checklist complete)
- Hall/stall management handlers
- Sponsor package management handlers

---

### 8.4 Identity Service (User/Org Management)
**Impact: HIGH — mostly new**

Currently handles attendee entities. Must be extended with a full user/org management surface:
- User invitation flow
- User CRUD (list, update status, disable)
- Organization CRUD
- Role assignment CRUD
- Multi-role user support

**New work required:**
- All endpoints in Part 4 §4.2–4.4
- Invitation token generation + email dispatch
- Set-password handler
- Role assignment validation rules (stall required for vendor_manager, etc.)

---

### 8.5 Notification Service
**Impact: MEDIUM**

Must be extended to send:
- User invitation emails (with magic link)
- Invite expiry reminders
- Account activation confirmations

**New work required:**
- New notification template: `user_invitation`
- New notification template: `invite_expiry_reminder`
- New notification template: `account_activated`
- Notification trigger hooks from Identity Service

---

### 8.6 Audit Service
**Impact: MEDIUM**

Currently audits sensitive data actions. Must extend to audit:
- User created / invited
- Role assigned / removed
- User disabled / re-enabled
- Event created / published / status changed
- Data policy changed
- Break-glass access requests

**New work required:**
- Audit event types for all above actions
- Admin audit log screen (A.3 Audit tab)
- Per-event audit log filtering (C.2 Audit tab)

---

### 8.7 Frontend Dashboards
**Impact: HIGH — all new screens**

All screens in Part 5 are new. Currently the spec has screen specs for Vendor, Sponsor, Organizer operational dashboards but nothing for admin/provisioning.

**New work required:**
- All screens in Group A (Platform Admin panel)
- All screens in Group B (Organizer team management)
- All screens in Group C (Event management)
- Shared `RoleAssignmentModal` component
- Invitation + Set Password screens
- Post-login routing logic
- Multi-role context picker

---

### 8.8 Database (Migrations)
**Impact: MEDIUM**

Schema is largely defined. Migrations needed:
- Ensure `user_role_assignments` has `event_id` (nullable FK) and `stall_ids` (UUID array or junction table) and `sponsor_package_id` (nullable FK) columns — these are implied in the spec but not explicitly in the starter schema columns
- Add `invited_by_user_id` to `users` table (for audit trail of who invited whom)
- Add `invitation_token_hash` + `invitation_expires_at` to `users` table
- Add `last_login_at` to `users` table

---

### 8.9 API Gateway / Routing
**Impact: LOW**

New route groups need to be registered:
- `/admin/*` — platform_admin only
- `/orgs/*` — platform_admin + organizer_admin scoped
- `/users/*` — platform_admin + organizer_admin scoped
- `/events` POST — platform_admin + organizer_admin
- `/admin/break-glass/*` — platform_admin only
- `/devices/*` — platform_admin + ops_user (scoped)
- `/branding/*` — organizer_admin + platform_admin
- `/auth/forgot-password`, `/auth/reset-password` — public (no auth)
- `/auth/change-password`, `/auth/me` — all authenticated users
- `/admin/api-clients/*` — platform_admin only

---

### 8.10 Break-Glass Service — G10
**Impact: HIGH — new service/module**

The `break_glass_access` table is defined in the spec schema but has no corresponding service layer. Must be built as a new module (can live inside the auth/admin service or as a standalone).

**New work required:**
- Full CRUD for break-glass requests (Part 4 §4.6)
- Approval enforcement (different user than requester, server-side)
- Session expiry enforcement (background job checking `expires_at`, revoking and re-masking)
- Real-time notification to all other Platform Admins on new request
- All audit events: `break_glass.requested`, `break_glass.approved`, `break_glass.rejected`, `break_glass.expired`, `break_glass.revoked`
- Active session check integrated into `responseMaskingMiddleware` — if active approved session exists for requesting user + scope, skip masking

---

### 8.11 Device Service Extensions — G11
**Impact: MEDIUM**

Device read operations already exist (fleet dashboard, heartbeat, diagnostics). Must be extended with a full provisioning surface.

**New work required:**
- Device registration endpoint (POST `/devices`)
- Device assignment endpoint (POST `/devices/{id}/assign`)
- Device unassign / retire endpoints
- NFC reader registration endpoint (POST `/nfc-readers`)
- Status transition guards: e.g., cannot retire a `live` device without unassigning first
- Audit events: `device.registered`, `device.assigned`, `device.unassigned`, `device.retired`
- Device detail screen (F.3) integration into Ops User front-end route `/ops/devices/{id}`

---

### 8.12 Branding Service Extensions — G12
**Impact: LOW-MEDIUM**

Branding API surface already exists in spec (§6.5). The existing endpoints cover the core flow. New work is primarily the frontend screens and the new `GET /events/{id}/branding/status` and `POST /events/{id}/branding/approve` endpoints.

**New work required:**
- `GET /events/{id}/branding/status` — returns `{status: draft|approved|published, last_published_at, device_count}`
- `POST /events/{id}/branding/approve` — sets approval flag; required before publish is allowed
- Publish guard: `POST /branding/publish` must check `approved = true` before proceeding
- Frontend: All screens in Group K (K.1, K.2)
- Audit events: `branding.approved`, `branding.published`

---

### 8.13 Auth Service Additional Extensions — G13
**Impact: MEDIUM**

Extends Phase 2 auth work with self-service password flows. Must be built on the same auth service.

**New work required:**
- `POST /auth/forgot-password` — rate-limited (max 3 requests per email per hour), always responds 200 (no enumeration)
- Password reset token: separate token type from invite token; 1 hour expiry; single-use
- `POST /auth/reset-password` — validate token, set password, invalidate token, optionally revoke all refresh tokens
- `POST /auth/change-password` — requires current password validation before accepting new one
- `GET /auth/me` + `PATCH /auth/me` — current user profile read/update
- Additional email template: `password_reset` (subject, magic link, 1-hour expiry notice)
- Rate limiting on all public auth endpoints (forgot-password, reset-password)

---

## PART 9 — STEP-BY-STEP BUILD SEQUENCE

Work is sequenced so each phase unblocks the next. No phase assumes work from a later phase.

---

### PHASE 1 — Database Migrations (Foundation)
*No dependencies. Do first.*

**Step 1.1** — Add missing columns to `user_role_assignments`:
- `event_id UUID REFERENCES events(id) ON DELETE CASCADE nullable`
- `stall_ids UUID[] nullable`
- `sponsor_package_id UUID REFERENCES sponsor_packages(id) nullable`
- `assigned_by_user_id UUID REFERENCES users(id)`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

**Step 1.2** — Add to `users` table:
- `invited_by_user_id UUID REFERENCES users(id) nullable`
- `invitation_token_hash TEXT nullable`
- `invitation_expires_at TIMESTAMPTZ nullable`
- `last_login_at TIMESTAMPTZ nullable`
- `password_reset_token_hash TEXT nullable`
- `password_reset_expires_at TIMESTAMPTZ nullable`

**Step 1.3** — Validate `organizations` table has `org_type` CHECK constraint and `status` field. Add `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))` if missing.

**Step 1.4** — Validate `events` table has all 5 status values in CHECK constraint: `draft, published, live, closed, archived`.

**Step 1.5** — Validate `break_glass_access` table exists per spec schema (Appendix D.3). If not, create it exactly per that schema including the `idx_break_glass_tenant_status` index.

**Step 1.6** — Add `branding_approved BOOLEAN NOT NULL DEFAULT FALSE` and `branding_approved_by UUID REFERENCES users(id) nullable` and `branding_approved_at TIMESTAMPTZ nullable` to `branding_profiles` table.

**Step 1.7** — Validate `api_clients` table exists with `status TEXT CHECK (status IN ('active','revoked'))`. Add `last_used_at TIMESTAMPTZ nullable` if missing.

**Step 1.8** — Validate `devices` table has all status values: `inventory, assigned, live, repair, retired`.

**Step 1.9** — Write migration + rollback scripts for all above. Run on dev, validate, document.

---

### PHASE 2 — Auth Service Extensions
*Depends on: Phase 1*

**Step 2.1** — Extend JWT payload to include:
```json
{
  "actor_id": "uuid",
  "tenant_id": "uuid",
  "org_id": "uuid",
  "roles": ["vendor_manager"],
  "event_ids": ["uuid"],
  "stall_ids": ["uuid"],
  "sponsor_package_ids": []
}
```

**Step 2.2** — Implement invite token issuance:
- Generate signed token (HMAC-SHA256 or JWT with `type: invite`)
- Hash token, store in `users.invitation_token_hash`
- Set `invitation_expires_at = now() + 72h`

**Step 2.3** — Implement `POST /auth/accept-invite`:
- Validate token (not expired, hash matches)
- Accept new password (validate complexity)
- Set `users.status = active`, clear token fields
- Return access JWT

**Step 2.4** — Implement post-login redirect resolver:
- After login, query `user_role_assignments` for user
- If single assignment → return redirect target
- If multiple events → return `requires_context_selection: true` with event list

**Step 2.5** — Implement self-service auth endpoints (G13):
- `POST /auth/forgot-password` — rate-limited, always 200, dispatches reset email
- `POST /auth/reset-password` — validates reset token (1h expiry, single-use), sets password, clears token
- `POST /auth/change-password` — requires current password, validates new password complexity
- `GET /auth/me` — returns current user profile
- `PATCH /auth/me` — updates full_name only

**Step 2.6** — Write unit tests for all auth flows. P0 — no deployment without passing tests.

---

### PHASE 3 — Identity / User Management API
*Depends on: Phase 1, Phase 2*

**Step 3.1** — Implement `GET /users` (list users, tenant-scoped, role-filtered)

**Step 3.2** — Implement `POST /users/invite`:
- Create user record (status: invited)
- Trigger invitation token generation (Phase 2)
- Dispatch invitation email via Notification Service

**Step 3.3** — Implement `GET /users/{id}`, `PATCH /users/{id}`, `POST /users/{id}/disable`

**Step 3.4** — Implement `POST /users/{id}/resend-invite`:
- Invalidate old token
- Generate new token
- Re-dispatch email

**Step 3.5** — Implement role assignment endpoints:
- `GET /users/{id}/roles`
- `POST /users/{id}/roles` (with validation rules from Part 4 §4.4)
- `DELETE /users/{id}/roles/{assignment_id}`

**Step 3.6** — Implement org management endpoints (Part 4 §4.2)

**Step 3.7** — Write integration tests for all user management + role assignment flows.

---

### PHASE 4 — Event Management API
*Depends on: Phase 1*

**Step 4.1** — Implement `POST /events` (create event, tenant-scoped)

**Step 4.2** — Implement `PATCH /events/{id}` (update details)

**Step 4.3** — Implement `POST /events/{id}/publish`:
- Check onboarding checklist: halls exist, stalls exist, sponsor packages exist, data policy row exists, at least one organizer_admin user assigned
- If any check fails: return 422 with failing checklist items listed
- If all pass: status → `published`

**Step 4.3b** — Implement `POST /events/{id}/go-live` (G16):
- Guard: status must be `published`
- Check: at least one device assigned and heartbeat received in last 10 min
- Check: branding profile exists and `branding_approved = true`
- If guards pass: status → `live`; broadcast config update to all assigned devices to enable tap ingestion
- Audit: `event.went_live`

**Step 4.3c** — Implement `POST /events/{id}/close` (G16):
- Guard: status must be `live`
- Confirm body required: `{"confirm_event_name": "string"}` — must match event name exactly
- On match: status → `closed`; broadcast config update to all assigned devices to stop tap ingestion
- Audit: `event.closed`

**Step 4.3d** — Implement `POST /events/{id}/archive` (G16, Platform Admin only):
- Guard: status must be `closed`
- Status → `archived`
- All event-scoped user role assignments marked inactive (users lose dashboard access)
- Audit: `event.archived`

**Step 4.4** — Implement hall CRUD (`POST /events/{id}/halls`, `PATCH /halls/{id}`, `DELETE /halls/{id}`)  
— Guard: DELETE only allowed when event status is `draft`

**Step 4.5** — Implement stall CRUD + org assignment (`POST /events/{id}/stalls`, `PATCH /stalls/{id}`)  
— Guard: org assignment changes only allowed when event status is `draft` or `published`

**Step 4.6** — Implement sponsor package CRUD

**Step 4.7** — Implement data policy write (`POST /events/{id}/data-policy`, `PATCH /events/{id}/data-policy`) with audit trigger

**Step 4.8** — Implement onboarding checklist computation endpoint: `GET /events/{id}/checklist`

---

### PHASE 5 — Middleware Extensions
*Depends on: Phase 2*

**Step 5.1** — Extend `roleScopeMiddleware` to check `event_id` in request against `event_ids[]` in PrincipalContext for all event-scoped routes.

**Step 5.2** — Extend to check `stall_id` against `stall_ids[]` for vendor_manager routes.

**Step 5.3** — Extend to check `sponsor_package_id` for sponsor_user routes.

**Step 5.4** — Add new error code: `EVENT_SCOPE_FORBIDDEN` (403) — returned when event not in user's scope.

**Step 5.5** — Write middleware unit tests covering all 7 role types and edge cases (user with multiple events, user with no stall, etc.)

---

### PHASE 6 — Notification Service Extensions
*Depends on: Phase 2, Phase 3*

**Step 6.1** — Create email template: `user_invitation`
- Subject: "You've been invited to [Platform Name]"
- Body: Full name, inviting org name, role, event name (if applicable), CTA button (Accept Invite), expiry notice (72h)

**Step 6.2** — Create email template: `invite_expiry_reminder` (sent at 48h if not accepted)

**Step 6.3** — Create email template: `account_activated`

**Step 6.4** — Create email template: `password_reset` (G13)
- Subject: "Reset your password"
- Body: Reset link, expires in 1 hour notice, "If you didn't request this, ignore this email"

**Step 6.5** — Create notification template: `break_glass_pending_approval` (G10)
- Fires to all other Platform Admins when a break-glass request is submitted
- Body: Requester name, justification summary, scope, [Review Request] CTA

**Step 6.6** — Wire all notification triggers:
- Phase 3 Step 3.2 (invite) → `user_invitation`
- Phase 3 Step 3.4 (resend) → `user_invitation`
- Phase 2 Step 2.5 (forgot password) → `password_reset`
- Break-glass request (Phase 13) → `break_glass_pending_approval`

---

### PHASE 7 — Audit Service Extensions
*Depends on: Phase 3, Phase 4*

**Step 7.1** — Add audit event types:
- `user.invited`
- `user.activated`
- `user.disabled`
- `user.re_enabled`
- `user.role_assigned`
- `user.role_removed`
- `user.password_reset_requested`
- `user.password_reset_completed`
- `user.password_changed`
- `org.created`
- `org.updated`
- `event.created`
- `event.published`
- `event.went_live`
- `event.closed`
- `event.archived`
- `event.data_policy_changed`
- `device.registered`
- `device.assigned`
- `device.unassigned`
- `device.retired`
- `branding.approved`
- `branding.published`
- `break_glass.requested`
- `break_glass.approved`
- `break_glass.rejected`
- `break_glass.expired`
- `break_glass.revoked`
- `api_client.created`
- `api_client.secret_rotated`
- `api_client.revoked`

**Step 7.2** — Ensure all Phase 2, 3, 4, and 13 handlers fire the correct audit events.

**Step 7.3** — Implement background job for break-glass session expiry: scans `break_glass_access` every minute for rows where `status = approved AND expires_at <= now()` → sets `status = expired`, fires `break_glass.expired` audit event, and re-applies masking for that user's session.

---

### PHASE 8 — Frontend: Shared Components
*Depends on: Phases 3, 4 APIs available (or mocked)*

**Step 8.1** — Build `RoleAssignmentModal` component (Part 5, Group D)

**Step 8.2** — Build `UserStatusBadge` component (active / invited / disabled)

**Step 8.3** — Build `OnboardingChecklist` widget for event detail

**Step 8.4** — Build `MultiRoleContextPicker` (post-login context selection)

**Step 8.5** — Build `SetPasswordScreen` (invite acceptance — Part 6)

**Step 8.6** — Build `ForgotPasswordScreen` (G.3) and `ResetPasswordScreen` (G.4)

**Step 8.7** — Build `MyAccountScreen` (G.1) and `ChangePasswordModal` (G.2)

**Step 8.8** — Build `BreakGlassSessionBanner` (E.3) — global component wired into admin layout

**Step 8.9** — Build `EventStatusActionButton` — renders the correct status-transition button (Publish / Go Live / Close Event / Archive) based on event.status and user role; used in C.1 and C.2

---

### PHASE 9 — Frontend: Platform Admin Panel
*Depends on: Phase 8*

**Step 9.1** — Build A.1 Tenant List Screen

**Step 9.2** — Build A.2 Create Tenant Modal

**Step 9.3** — Build A.3 Tenant Detail Screen (all 6 tabs — including updated API Clients tab)

**Step 9.4** — Build A.4 Create Organization Modal

**Step 9.5** — Build A.5 Invite User Flow (2-step modal)

**Step 9.6** — Build A.6 Create Event Wizard (4-step)

**Step 9.7** — Build A.7 User Detail Screen

**Step 9.8** — Build I.1 Organization Detail Screen (G15)

**Step 9.9** — Build H.1 API Clients Screen, H.2 Create API Client Modal, H.3 API Client Detail (G14)

**Step 9.10** — Build E.1 Break-Glass Request Screen, E.2 Approve/Reject Screen, E.4 Break-Glass History Screen (G10)

**Step 9.11** — Build F.1 Device Inventory Screen, F.2 Register Device Modal, F.3 Device Detail Screen (G11) — Platform Admin views

---

### PHASE 10 — Frontend: Organizer Team & Event Management
*Depends on: Phase 8, Phase 9 components*

**Step 10.1** — Build B.1 Organizer Team Management Screen

**Step 10.2** — Build B.2 Organizer Invite Team Member Flow

**Step 10.3** — Build B.3 Team Member Detail Screen

**Step 10.4** — Build C.1 Organizer Event List Screen (with `EventStatusActionButton` from Phase 8.9)

**Step 10.5** — Build C.2 Organizer Event Detail Screen (all tabs including Branding tab → K.1)

**Step 10.6** — Build I.2 Stall Detail Screen (G17)

**Step 10.7** — Build I.3 Sponsor Package Detail Screen (G18)

**Step 10.8** — Build K.1 Event Branding Tab and K.2 Publish Branding Confirmation Modal (G12)

**Step 10.9** — Build J.1 Go Live Confirmation Modal, J.2 Close Event Confirmation Modal, J.3 Archive Confirmation Modal (G16)

**Step 10.10** — Build F.3 Device Detail (Ops User view), F.4 Assign Device Modal, F.5 Pair NFC Reader Modal (G11 — Ops-facing)

---

### PHASE 11 — Post-Login Routing
*Depends on: Phase 2 (auth resolver), Phase 8 (context picker)*

**Step 11.1** — Implement post-login role-based redirect (Part 7 routing table)

**Step 11.2** — Implement multi-role context picker screen

**Step 11.3** — Implement session context storage (selected event_id persists in session for multi-role users)

---

### PHASE 12 — QA & Integration Testing
*Depends on: All phases 1–11*

#### Core User & RBAC Flows

**Step 12.1** — End-to-end: Platform Admin creates tenant → creates org → invites Organizer Admin → Organizer creates event → invites Vendor Manager with stall scope → Vendor logs in → sees only own stall's lead inbox

**Step 12.2** — End-to-end: Organizer invites Sponsor User with sponsor package scope → Sponsor logs in → sees only sponsor analytics → cannot see vendor inbox → cannot access organizer controls

**Step 12.3** — RBAC boundary: Vendor Manager attempts to access another stall's leads → 403 with `STALL_SCOPE_FORBIDDEN`

**Step 12.4** — RBAC boundary: Vendor Manager attempts to access a different event → 403 with `EVENT_SCOPE_FORBIDDEN`

**Step 12.5** — RBAC boundary: Organizer Admin attempts to create another Organizer Admin → blocked at UI and API level

**Step 12.6** — Multi-role user: User assigned as Vendor Manager for two different events → context picker appears on login → selecting Event A scopes all subsequent requests to Event A

#### Invitation Lifecycle

**Step 12.7** — Invite accepted within 72h → token validated → password set → status = active → login works

**Step 12.8** — Invite not accepted in 72h → token expired → activation fails with clear error → Admin resends → new token works, old token invalid

**Step 12.9** — Duplicate email invite → blocked with inline error at UI and 409 at API level

#### Password Reset (G13)

**Step 12.10** — Forgot password: valid email → email sent → token used within 1h → password reset → login with new password succeeds

**Step 12.11** — Forgot password: expired token (>1h) → reset page shows expired error → user can request new reset

**Step 12.12** — Forgot password: non-existent email → UI still shows "if account exists, email sent" (no enumeration)

**Step 12.13** — Change password: correct current password → new password accepted → old password no longer works

**Step 12.14** — Change password: wrong current password → 401, inline error

#### Event Status Transitions (G16)

**Step 12.15** — draft → published: all checklist items pass → published successfully

**Step 12.16** — draft → published: missing stall → 422 with specific checklist failures listed

**Step 12.17** — published → live: device assigned and heartbeat valid, branding approved → goes live, devices start accepting taps

**Step 12.18** — published → live: branding not approved → Go Live button disabled, blocked

**Step 12.19** — live → closed: correct event name typed in confirmation → event closed, devices stop accepting taps

**Step 12.20** — live → closed: wrong event name typed → blocked, error inline

**Step 12.21** — closed → archived: Platform Admin only → event archived, Organizer loses dashboard access

**Step 12.22** — archived event: Organizer tries to access event dashboard → event hidden by default; visible via "Show archived" filter, all data read-only

#### Break-Glass Workflow (G10)

**Step 12.23** — Platform Admin A submits break-glass request → Platform Admin B receives notification → B approves → A's PII fields unmask immediately, session banner appears

**Step 12.24** — Self-approval attempt: Platform Admin tries to approve own request → approve button disabled in UI, API returns 403 with `SELF_APPROVAL_FORBIDDEN`

**Step 12.25** — Break-glass session expires: countdown hits zero → fields re-mask in A's session without page reload, status becomes `expired`

**Step 12.26** — Manual revoke: Platform Admin B revokes A's active session → A's session re-masks within 60 seconds

**Step 12.27** — All break-glass actions (request, approve, reject, expire, revoke) appear in audit log with correct actor, action, timestamp

#### Device Provisioning (G11)

**Step 12.28** — Platform Admin registers new device → device appears in inventory with status `inventory`

**Step 12.29** — Ops User assigns device to event + stall → device status changes to `assigned`, stall device assignment visible

**Step 12.30** — Duplicate stall assignment: second device assigned to already-occupied stall → 409 error

**Step 12.31** — Retire device: only allowed when status ≠ `live` → attempt to retire live device → blocked with error

**Step 12.32** — NFC reader paired to device → appears in device detail, diagnostics screen shows reader status

#### Branding Management (G12)

**Step 12.33** — Upload sponsor logo → preview renders inline → save draft → status = `Draft`

**Step 12.34** — Attempt to publish without approval → [Publish to Fleet] disabled, tooltip explains why

**Step 12.35** — Mark as approved → Publish button enabled → publish to fleet → N devices receive update, status = `Published`

**Step 12.36** — Publish with some unreachable devices → partial success toast shows count, unreachable devices will receive update on next config poll

#### API Client Management (G14)

**Step 12.37** — Create API client → client_id and client_secret displayed once → copy and close → secret never shown again

**Step 12.38** — Rotate secret → old secret invalidated immediately → API call with old secret returns 401 → API call with new secret succeeds

**Step 12.39** — Revoke client → all API calls with that client's credentials return 401

#### Data Policy Interaction

**Step 12.40** — Organizer disables vendor exports → vendor export button disabled in UI → export API call returns 403

**Step 12.41** — Organizer enables sponsor PII → sponsor user can now see consented lead data → disabling reverts immediately

#### Audit Completeness

**Step 12.42** — All actions from Steps 12.1–12.41 produce correct audit log entries: actor, action type, target resource, tenant_id, timestamp. No action is unaudited.

---

### PHASE 13 — Break-Glass Service & Device Provisioning Backend
*Depends on: Phase 1 (DB), Phase 2 (Auth), Phase 7 (Audit)*

**Step 13.1** — Implement Break-Glass CRUD endpoints (Part 4 §4.6):
- `POST /admin/break-glass/request`
- `GET /admin/break-glass`
- `GET /admin/break-glass/{id}`
- `POST /admin/break-glass/{id}/approve` — enforce `approved_by_user_id ≠ requested_by_user_id` at DB + API level
- `POST /admin/break-glass/{id}/reject` — require `rejection_reason`
- `POST /admin/break-glass/{id}/revoke`

**Step 13.2** — Integrate break-glass check into `responseMaskingMiddleware`:
- If request actor has active approved break-glass session with matching `access_scope` → skip masking for that scope
- Else → apply masking as normal
- Session validity check: `status = approved AND expires_at > now()`

**Step 13.3** — Implement break-glass expiry background job:
- Runs every 60 seconds
- Finds `break_glass_access` rows where `status = approved AND expires_at <= now()`
- Sets `status = expired`
- Fires `break_glass.expired` audit event
- Publishes session invalidation event via realtime channel so client UI re-masks without page reload

**Step 13.4** — Implement Device Provisioning endpoints (Part 4 §4.7):
- `POST /devices` (register)
- `PATCH /devices/{id}` (update name, status — with transition guards)
- `POST /devices/{id}/assign` (validate stall not already occupied)
- `POST /devices/{id}/unassign`
- `POST /devices/{id}/retire` (guard: cannot retire `live` device)
- `POST /nfc-readers` (pair reader to device)
- `PATCH /nfc-readers/{id}`

**Step 13.5** — Implement API Client Management endpoints (Part 4 §4.10):
- `POST /admin/api-clients`
- `GET /admin/api-clients` / `GET /admin/api-clients/{id}`
- `POST /admin/api-clients/{id}/rotate-secret` — generate new secret, hash and store, invalidate old hash, return plaintext secret once
- `POST /admin/api-clients/{id}/revoke`

**Step 13.6** — Write integration tests for all Phase 13 endpoints. Include self-approval rejection, expiry job simulation, and device transition guard tests.

---

## PART 10 — DEPENDENCY MAP SUMMARY

```
Phase 1 (DB Migrations)
        ↓
Phase 2 (Auth Extensions) ─────────────────────────────┐
        ↓                                               ↓
Phase 3 (User/Org API)    Phase 4 (Event API)    Phase 5 (Middleware)
        ↓         ↓               ↓
Phase 6 (Notifications)   Phase 7 (Audit + Expiry Job)
                   ↓                   ↓
             Phase 13 (Break-Glass + Device + API Client backend)
                              ↓
                    Phase 8 (Shared UI Components)
                         ↓               ↓
              Phase 9 (Admin Panel)   Phase 10 (Organizer UI)
                              ↓
                    Phase 11 (Post-Login Routing)
                              ↓
                       Phase 12 (QA — 42 test cases)
```

---

## PART 11 — WHAT MUST NOT CHANGE IN EXISTING SPEC

The following existing behaviours must be preserved exactly as-is while building this new layer:

1. **Tap flow is untouched.** No user management, break-glass, or device provisioning change may touch `/interactions/tap` latency or the offline queue. Break-glass operates on read paths only.
2. **Response masking stays in `responseMaskingMiddleware`.** RBAC additions happen in `roleScopeMiddleware` only, upstream. Break-glass check is an additive bypass condition inside `responseMaskingMiddleware` — it does not remove or reorder the middleware.
3. **Consent still gates all PII.** Role assignment and break-glass access do not bypass consent. A Vendor Manager with stall scope still sees only consented leads. A Platform Admin with active break-glass can see unmasked records but only those where the underlying data exists — consent is not fabricated.
4. **No bulk attendee ingestion.** The user invitation system is for platform users (staff, vendors, sponsors, organizers) — not attendees. No invitation flow may create an `attendees` record.
5. **Audit is append-only.** No admin action, including disabling a user, revoking a client, or archiving an event, may delete or modify an existing audit log entry.
6. **Break-glass self-approval is permanently forbidden.** This is a hard constraint at DB level (`approved_by_user_id ≠ requested_by_user_id`) and must be enforced at both API and UI layer. No future change may relax this.
7. **Device retirement guard.** A device with `status = live` may never be retired without first being unassigned. This must be enforced at API level — the UI alone is insufficient.
8. **Branding publish requires approval.** The `POST /branding/publish` endpoint must always check `branding_approved = true` before propagating to fleet. This cannot be bypassed even by Platform Admin, except via explicit approval action.
9. **retention_days only accepts enum values.** Only 30, 60, 90, 180, 365 are valid. This must be enforced at DB CHECK constraint level and API validation level. Setting 45 days is permanently invalid.
10. **Event status transitions are one-way except via explicit admin intervention.** `draft → published → live → closed → archived` is the only forward path. Reversal (e.g., re-opening a closed event) requires Platform Admin and must be explicitly scoped as a future feature — it is not permitted in this build.

---

*End of plan — v2. All 20 identified gaps addressed. 13 build phases, 10 screen groups (A–K), 42 QA test cases.*

---

# ═══════════════════════════════════════════════════════════
# PART 12 — DATA SOVEREIGNTY GAP ANALYSIS (INDIAN MARKET)
# ═══════════════════════════════════════════════════════════

## 12.1 Context and Market Requirement

Indian exhibition organisers, event sponsors, and vendors operate under a specific concern: that the platform operator has unchecked access to all interaction data, attendee PII, export history, and policy settings belonging to their events. This concern is material under India's Digital Personal Data Protection Act 2023 (DPDP Act), which designates organisers as Data Fiduciaries with obligations around data minimisation, purpose limitation, data subject rights, and consent governance. The platform, operating as a Data Processor, must be structurally constrained — not just policy-constrained — from exceeding its mandate.

The spec defines a trust-first architecture with many controls already in place. However, 11 specific gaps exist where the spec either defines a rule without a code mechanism, references a capability in a single line without speccing it, or is entirely silent. Each gap is a potential trust-breaker with an Indian enterprise organiser.

---

## 12.2 Verified Build Status — Confirmed Against Codebase (Claude Code Audit)

> **Audit method:** Claude Code ran against the full repository, grepping source files, migrations, route handlers, middleware, and worker files. The following table replaces all previous "Unknown" entries with confirmed status.

| Control | Spec Status | **Verified Build Status** | Evidence |
|---------|-------------|--------------------------|----------|
| Organizer-owned data policy | ✅ Fully defined | ✅ **Built** | `event_data_policies` table + `enforcePolicy()` + organizer data-control routes |
| Zero database ingestion | ✅ Rule defined | ✅ **Built** | `ingest-tap.mjs` creates tap/interaction with `attendee_id: null`; PII only arrives post-consent via attendee session |
| Platform Admin masking by default | ✅ Middleware defined | ✅ **Built** | `masking.mjs` masks all fields for `platform_admin` unless active break-glass session with `stall_leads_unmask` scope |
| Break-glass (request/approve/audit) | ✅ Schema + rules defined | ✅ **Built** | Full routes (request/approve/revoke/list); dual-approver guard in `policy.mjs`; scope enforcement; audit trail |
| Dual granular consent | ✅ Fully defined | ✅ **Built** | `vendor_release_allowed` + `sponsor_release_allowed` in `consents` table; `consent_events` append-only history; enforced at mask + export time |
| Export recalculation at generation | ✅ Rule defined | ✅ **Built** | `buildLeadExportPayload()` re-fetches live interactions + re-checks policy at download time; code comment explicitly states "excluded at download time" |
| Tenant isolation | ✅ DB + middleware rule | ✅ **Built** | Migration 003 enables RLS + `app_current_tenant_id()` policy on every table; all queries in `postgres.mjs` pass `tenant_id` |
| Audit trail (append-only) | ✅ Table defined | ✅ **Built** | Migration 016: `REVOKE UPDATE, DELETE ON audit_logs FROM app_runtime` — DB-level enforcement, not just application policy |
| DSR workflow (schema) | ✅ Schema defined | ✅ **Built** | Schema exists; `organizer-dsr-list/create/complete`, `attendee-dsr-create`, downstream-deletion routes all implemented |
| DSR workflow (UI + API + worker) | ❌ Not specced | ⚠️ **Partial** | API routes exist; **no background worker**; processing is manual (organizer completes via API); **no attendee self-service UI** |
| Retention purge job | ❌ Rule defined, job not specced | ⚠️ **Partial** | `organizer-retention-run` route exists (manual trigger only); **no scheduled cron job or autonomous worker** |
| Organizer visibility of platform actions | ❌ Not defined | ❌ **Not built** | Organizers can read audit logs generally but no dedicated "platform admin accessed your event data" view or filter |
| Organizer full data export / portability | ❌ Not defined | ❌ **Not built** | Organizer exports exist (compliance audit, event report) but no full tenant-scoped portability package |
| Sovereignty webhook events | ❌ Not in catalogue | ❌ **Not built** | Webhook catalogue has 6 types (interaction.created, consent.updated, etc.); no sovereignty/deletion/portability events |
| Offboarding / contract-end data deletion | ❌ Not defined | ❌ **Not built** | No tenant offboarding flow, no contract-end trigger, no cross-event deletion pipeline |
| Privacy audit log (separate table) | ⚠️ Recommended only | ❌ **Not built** | Privacy actions log into the same `audit_logs` table; no separate `privacy_audit_log` table |
| Data residency (India) | ❌ Entirely absent | ❌ **Not built** | No region routing, no storage locality config, no India-specific controls anywhere in the codebase |
| Organizer break-glass notification | ⚠️ One line, not specced | ❌ **Not built** | Break-glass is audited but no notification sent to organizer when Platform Admin activates access |

### Build Status Summary

| Status | Count | Controls |
|--------|-------|---------|
| ✅ Fully built | 9 | Data policy, zero ingestion, masking, break-glass core, consent, export recalc, tenant isolation, audit append-only, DSR schema |
| ⚠️ Partially built | 2 | DSR worker (API only, no cron/UI), Retention purge (manual trigger only, no scheduler) |
| ❌ Not built | 7 | Platform access log, full portability export, sovereignty webhooks, offboarding, privacy_audit_log table, data residency, break-glass organizer notification |

> **Key finding from codebase audit:** The spec's trust architecture translated faithfully into code for all 9 core controls. The 7 not-built items are all in the sovereignty/transparency layer — the controls that protect organizer interests *against* the platform, rather than protecting attendees from third parties. This is the exact gap that matters in the Indian market.

---

## 12.3 The 11 Sovereignty Gaps — Revised Priority Table

> Priority updated based on codebase reality. Partial builds (SG3, SG7) are P0 because the automation gap means the feature is unreliable in production at scale.

| # | Gap ID | Description | Codebase Reality | Revised Priority | DPDP Relevance |
|---|--------|-------------|-----------------|-----------------|----------------|
| 1 | SG1 | No organizer visibility into Platform Admin actions | ❌ Not built | P0 | Direct — processor accountability |
| 2 | SG2 | No organizer full data export / portability right | ❌ Not built | P0 | Direct — data portability right |
| 3 | SG3 | Retention purge is manual-only — no autonomous worker | ⚠️ Partial | P0 | Direct — unenforceable at scale |
| 4 | SG4 | No organizer notification on data policy changes | ❌ Not built | P0 | Direct — transparency obligation |
| 5 | SG5 | Webhook catalogue missing sovereignty events | ❌ Not built | P1 | Indirect — real-time transparency |
| 6 | SG6 | No offboarding / contract-end data deletion workflow | ❌ Not built | P0 | Direct — deletion obligation on termination |
| 7 | SG7 | DSR worker absent — processing is manual only, no attendee UI | ⚠️ Partial | P0 | Direct — DPDP mandates fulfilment |
| 8 | SG8 | No organizer-facing Platform Admin action audit view | ❌ Not built | P0 | Direct — processor accountability |
| 9 | SG9 | No separate `privacy_audit_log` table | ❌ Not built | P1 | Regulatory evidence production |
| 10 | SG10 | No data residency control | ❌ Not built | P1 | Sensitive data localisation |
| 11 | SG11 | No organizer notification on break-glass access | ❌ Not built | P0 | Trust — organiser unaware of access |

---

## 12.4 Gap-by-Gap Detailed Analysis

### SG1 — No Organizer Visibility Into Platform Admin Actions

**What the spec says:** Platform Admin actions are recorded in `audit_logs`. The organizer dashboard depends on `audit_logs` (§24.1). However, the spec never explicitly grants organizers read access to audit log entries created by Platform Admins acting on their event.

**The gap:** An organiser cannot currently query "Did a Platform Admin read or export my attendees' data?" or "Was break-glass used against my event?" This means the platform's trustworthiness is based entirely on the platform's own disclosure — not on the organiser's ability to independently verify.

**What needs to be built:** A filtered audit log view accessible to Organizer Admins showing all actions taken against resources belonging to their events — including Platform Admin and ops_user actions. This view must be read-only, immutable, and not filterable by the Platform Admin before the organiser sees it.

---

### SG2 — No Organizer Full Data Export / Portability Right

**What the spec says:** Export types include `vendor_leads_csv`, `sponsor_leads_csv`, `organizer_report_csv/json`, and `dsr_export_json`. However, `organizer_report_csv/json` is defined only as analytics reporting — not as a complete portable dataset of all event data (interactions, consents, policies, audit trail).

**The gap:** If an organiser terminates their contract or wants to migrate to a competing platform, there is no mechanism to export: the full interaction dataset, all consent records, the data policy history, the audit log for their event, and their attendee vault data. Without this, the organiser is locked into the platform by data gravity.

**What needs to be built:** A "Full Event Data Export" feature — a complete, structured, machine-readable export of everything the organiser owns, packaged for portability. Separate from the lead export workflow.

---

### SG3 — Retention Purge Is Manual-Only (No Autonomous Worker)

**What the spec says:** §21 mandates that after `retention_days` expires, PII fields must be anonymised or deleted. §4.8 references "retention job" as a downstream dependency.

**What the codebase has:** An `organizer-retention-run` route exists — meaning the retention logic is implemented. However it is a **manually triggered API endpoint**, not a scheduled autonomous worker. A human must call it; nothing calls it automatically.

**Why this is a P0 gap:** At scale with dozens of active events, manual retention execution is unreliable, unauditable as an autonomous process, and legally insufficient. Under DPDP, the retention commitment must be self-enforcing. If someone forgets to trigger the route, the platform is in breach of its stated retention policy.

**What needs to be built:** A scheduled cron worker that runs nightly, identifies events past their `retention_days` threshold, executes the existing retention logic automatically, notifies the organiser, and writes a `privacy_audit_log` entry per event purged. The manual route can remain as an override — but automatic execution is the requirement.

---

### SG4 — No Organizer Notification on Policy Changes by Platform Admin

**What the spec says:** "No policy changes without organizer awareness" appears in §10.2 as an operational protocol instruction. The platform admin is technically capable of calling `PATCH /events/{id}/data-policy`.

**The gap:** There is no code mechanism that notifies an organiser when their event's data policy is changed by a Platform Admin. The operational rule is unenforceable without a system notification.

**What needs to be built:** A policy change notification that fires to the Organizer Admin whenever any `event_data_policies` row is modified, showing: what changed, who changed it, and when. This applies even when the organiser makes the change (confirmation receipt).

---

### SG5 — Webhook Catalogue Missing Sovereignty Events

**What the spec says:** The webhook event catalogue (§8) defines 9 events covering operational signals (interaction.created, consent events, device events, sponsor banner clicks). All are inward-facing operational events.

**The gap:** There are no outbound webhook events for data governance actions: policy changes, break-glass access, export completion, retention execution, or audit events. Organisers with enterprise integrations cannot subscribe to be notified when their data is accessed or when governance actions are taken.

**What needs to be built:** 6 new webhook event types added to the authoritative catalogue.

---

### SG6 — No Offboarding / Contract-End Data Deletion Workflow

**What the spec says:** The spec has no section covering what happens when an organiser relationship ends. There is no concept of tenant deactivation, data handover, or scheduled deletion on contract termination.

**The gap:** Under DPDP, a Data Processor must delete or return personal data to the Data Fiduciary upon termination of the processing agreement. Without a defined workflow, the platform retains data indefinitely after contract end — which is a compliance violation.

**What needs to be built:** A tenant offboarding workflow with three options: (a) full data export then delete, (b) immediate deletion with confirmation, (c) retention for a grace period then deletion. Each path must be audited and notified.

---

### SG7 — DSR Worker Absent; Attendee Self-Service UI Missing

**What the spec says:** The `data_subject_requests` table is fully defined (§10). Rules state: delete triggers anonymisation workflow; export generates privacy-safe file; all actions audited.

**What the codebase has:** API routes are implemented — `organizer-dsr-list`, `organizer-dsr-create`, `organizer-dsr-complete`, `attendee-dsr-create`, and downstream-deletion routes all exist. This is meaningful progress.

**What is missing:**
1. **No background worker** — DSR completion is manual. An organiser must call the `complete` endpoint; nothing processes requests automatically.
2. **No attendee self-service UI** — Attendees have an `attendee-dsr-create` endpoint available but no UI surface to submit, track, or download their requests.
3. **No DSR export worker** — The export path for a DSR request (generating the attendee's privacy-safe data package) has no worker implementation.

**Why this is P0:** Under DPDP, a data subject's right to access or erasure must be fulfilled within a defined timeframe. Manual processing is a compliance liability at scale. The attendee self-service UI gap means attendees cannot practically exercise their rights without contacting the organiser directly.

**What needs to be built:** (a) A DSR processing worker triggered by new requests in `requested` status. (b) An attendee-facing UI on the contact detail / profile page. (c) A DSR export file generator. The API routes already built are a strong foundation — this is completion work, not greenfield.

---

### SG8 — No Organizer-Facing Audit Trail for Platform Admin Actions

**What the spec says:** The C.2 Event Detail Audit tab in our plan shows the audit log for event actions. The `audit_logs` table records Platform Admin actions.

**The gap:** The existing audit tab design does not distinguish between organiser actions and Platform Admin actions. There is no dedicated, separate view that surfaces "what the platform did to your data" vs. "what you did with your data." This distinction is critical for trust and for regulatory evidence.

**What needs to be built:** A dedicated "Platform Access Log" tab within the organiser's event detail view, showing only actions by Platform Admin or ops_user roles — filtered and read-only.

---

### SG9 — `privacy_audit_log` Is Recommended, Not Required

**What the spec says:** §9.3 notes `privacy_audit_log` as a "recommended addition" — a dedicated table separating privacy events from operational audit logs.

**The gap:** Under DPDP, a Data Processor may be compelled by the Data Protection Board to produce a record of all personal data processing activities. A mixed-purpose `audit_logs` table makes this extraction complex and contestable. A separate `privacy_audit_log` table is necessary for clean regulatory evidence production.

**What needs to be built:** The `privacy_audit_log` table elevated from recommended to required, with a defined schema, event types, and retention policy independent of operational logs.

---

### SG10 — No Data Residency Control

**What the spec says:** The spec contains zero mention of server location, data residency, or India-specific infrastructure requirements.

**The gap:** Under DPDP §16 and the associated Rules (expected 2024), certain categories of sensitive personal data must be stored and processed on servers physically located in India. Without data residency controls, the platform may be legally prohibited from processing Indian attendees' sensitive data. This is an infrastructure and configuration gap, not just a feature gap.

**What needs to be built:** A data residency configuration at the tenant level (India / EU / Global), infrastructure tagging, and a compliance dashboard showing which tenants have data residency requirements and whether they are being met.

---

### SG11 — Enterprise-Tier Organizer Break-Glass Notification Is Unspecced

**What the spec says:** §4.8 contains one line: "enterprise tier optional organizer notification." No template, trigger, UI, or API is defined.

**The gap:** The most trust-critical action the platform can take — accessing an organiser's unmasked attendee PII — has no notification mechanism to the organiser. In the Indian market, this must be non-optional at all tiers, not just enterprise.

**What needs to be built:** Organizer notification on every break-glass access request affecting their event — covering both the request and the approval, with the justification visible to the organiser.

---

# ═══════════════════════════════════════════════════════════
# PART 13 — SOVEREIGNTY SCREEN SPECIFICATIONS
# ═══════════════════════════════════════════════════════════

### SCREEN GROUP L: ORGANIZER SOVEREIGNTY CONTROLS

---

#### L.1 — Organizer: Platform Access Log Screen — SG1, SG8

**Route:** `/organizer/events/{id}/platform-access-log`  
**Access:** Organizer Admin only  
**Purpose:** Read-only view of all actions taken by Platform Admin or Ops User roles against this event's data. Completely separate from the event's own audit tab.

**Layout:** Full-width table with sticky header

**Table columns:**
- Timestamp (UTC + IST display)
- Actor (masked as "Platform Admin" or "Ops User" — individual identity withheld for internal privacy, but role is visible)
- Action Type (categorised badge: `data_access` / `policy_change` / `break_glass` / `export_action` / `config_change`)
- Target Resource (e.g., "Attendee data", "Event data policy", "Export #EXP-2045")
- Justification (shown only for break-glass entries; truncated with [expand])
- Duration (for break-glass sessions: "Active 47 min")
- Outcome (accessed / denied / expired)

**Filters:**
- Action Type (multi-select)
- Date range
- Outcome

**Export:**
- [Download as CSV] — produces an organiser-downloadable CSV of the full platform access log for this event. Timestamp of CSV download is itself logged.

**Important UX note:**  
A banner at the top of this screen reads: *"This log shows all actions taken by platform operators on your event's data. You cannot modify this log. If you have concerns, contact your account manager or raise a dispute."*

**Empty state:** "No platform access has occurred on this event. This log will populate if platform operators access your data."

---

#### L.2 — Organizer: Data Policy Change Receipt Screen — SG4

**Route:** Notification → deeplinks into `/organizer/events/{id}/data-policy?highlight={change_id}`  
**Access:** Organizer Admin  
**Purpose:** Every time an `event_data_policies` row is changed (by anyone, including the organiser themselves), a notification is dispatched and the change is surfaced inline in the Data Policy tab.

**In-tab change history widget** (added to existing C.2 Data Policy tab):
- Expandable section: "Policy Change History"
- Table: Changed At | Changed By (role + name) | Field Changed | Old Value | New Value
- Each row has a "Confirmed receipt" badge (auto-set when Organiser Admin views the tab after the change)
- If a Platform Admin made the change: row is highlighted in amber with label "Changed by Platform Operator"

**Notification (email + in-app):**
- Subject: "Data policy updated on [Event Name]"
- Body: What changed, who changed it (role only), when, [Review Changes] CTA
- Fires regardless of who made the change

---

#### L.3 — Organizer: Full Event Data Export Screen — SG2

**Route:** `/organizer/events/{id}/data-export`  
**Access:** Organizer Admin  
**Purpose:** Request and download a complete, portable export of all event data owned by the organiser.

**Export packages available (checkboxes, all selected by default):**
- ☑ All interaction records (anonymised where consent was not given)
- ☑ All consent records (with timestamps and consent event history)
- ☑ All lead exports requested during this event (metadata only — actual files if still within retention)
- ☑ Event configuration (halls, stalls, sponsor packages, data policy history)
- ☑ Platform access log (full log as seen in L.1)
- ☑ Audit trail (all event-scoped audit log entries)
- ☑ Attendee data (PII only for consented interactions, anonymised otherwise)

**Format selection:** JSON (default) | CSV (flattened) | ZIP (both)

**Submit:** [Request Full Export]
- POST `/events/{id}/full-export`
- Creates an export job; status shown in the screen (requested → processing → ready)
- When ready: signed expiring download link (24h expiry)
- Email notification sent when ready

**Constraints:**
- Only one active full-export request per event at a time
- Export generation must respect current consent state (not a historical snapshot of consents)
- Export job is audited: `event.full_export_requested`, `event.full_export_completed`, `event.full_export_downloaded`

**Post-export notice:**  
*"This export contains personal data. You are responsible for its secure storage and handling under applicable data protection law."*

---

#### L.4 — Admin: Tenant Offboarding Workflow — SG6

**Route:** `/admin/tenants/{id}/offboarding`  
**Access:** Platform Admin only  
**Purpose:** Structured, audited process for ending a tenant relationship and handling their data.

**Step 1 — Confirm Intent:**
- Tenant name, active events count, total data records estimate
- Warning: "This action cannot be undone. All data will be handled according to the selected option below."
- Require typing tenant slug to confirm intent

**Step 2 — Select Data Handling Path:**

Three options (radio select):

**Option A — Export then Delete:**
- Generate full data export package for organiser (all tenants' data across all events)
- Export delivery method: encrypted email link / SFTP / secure download
- After organiser confirms receipt: schedule deletion job (T+7 days by default, configurable 1–30 days)
- Deletion job anonymises all PII, removes attendee records, removes interaction PII fields
- Audit log + privacy_audit_log entries retained indefinitely

**Option B — Immediate Deletion:**
- No export generated
- All PII fields anonymised immediately
- Attendee records marked deleted
- Interactions retain anonymised form only
- Requires second Platform Admin to approve (same pattern as break-glass)
- Confirmation email sent to the organiser's primary contact with deletion certificate

**Option C — Grace Period then Delete:**
- Tenant data frozen (no new events, no new interactions)
- Grace period: 30, 60, or 90 days (select)
- After grace period: auto-execute Option A (export + delete)
- Organiser notified at T-14 days and T-3 days before deletion

**Step 3 — Review and Execute:**
- Summary of selected path, timeline, organiser contact
- [Execute Offboarding] → POST `/admin/tenants/{id}/offboard`
- Fires `tenant.offboarding_initiated` audit event

**Deletion Certificate:**
- Auto-generated PDF containing: tenant name, date of deletion, data categories deleted, method, executed by (Platform Admin ID hash — not name), witness (second approver ID hash)
- Delivered to organiser's primary email
- Stored in platform records for 7 years (legal retention for compliance evidence)

---

#### L.5 — Attendee: Data Subject Request Flow — SG7

**Route:** `/attendee/privacy` (accessible from the attendee contact detail page)  
**Access:** Authenticated attendee (via short-link session)  
**Purpose:** Allow an attendee to submit an export or delete request for their personal data.

**Screen layout:**

**Section 1 — Your Data Summary:**
- Number of events attended (consented interactions)
- Number of vendors who accessed your data
- Number of exports containing your data
- [View full connection history] → existing contact detail page

**Section 2 — Your Rights:**

Two request types:

**[Export My Data]**
- Generates a privacy-safe JSON export of: attendee profile, all interactions, consent history, export metadata
- Excludes: other attendees' data, vendor notes/scores (those belong to the vendor)
- Status: submitted → processing → ready (email notification with download link, 24h expiry)

**[Delete My Data]**
- Warns: "Deleting your data will remove your personal information from this platform. Your anonymised interaction records will be retained for event analytics."
- Requires confirmation: type email address to confirm
- On submission: attendee PII fields nulled/anonymised across `attendees`, `interactions`, `consents` tables
- Vendor lead inboxes: attendee record replaced with "Anonymous Visitor"
- CRM: deletion request dispatched to any CRM systems where attendee data was pushed (best-effort — logged if CRM does not support deletion)
- Status tracking in `data_subject_requests` table

**In-progress state:** If a request is already processing, show status badge and estimated completion time. Only one active request per type per attendee.

---

#### L.6 — Organizer: DSR Management Screen — SG7

**Route:** `/organizer/events/{id}/privacy-requests`  
**Access:** Organizer Admin  
**Purpose:** View and manage data subject requests from attendees at their event.

**Table columns:**
- Submitted At
- Request Type (Export / Delete)
- Status badge (requested / processing / completed / rejected / failed)
- Completed At
- Actions: [View Detail] [Mark as Rejected with reason] (only for requests the organiser must manually approve — configurable per event)

**Default behaviour:** DSR requests auto-process (no organiser action required). Organiser can optionally enable "Manual DSR approval mode" per event in data policy settings — in this mode, delete requests queue for organiser review before execution.

**Export DSR Detail:** Shows which data categories were included in the generated export.

**Delete DSR Detail:** Shows which fields were anonymised, which CRM push deletion was attempted.

**Completion stats widget:**
- Total requests: N
- Avg processing time: N hours
- Completion rate: N%

---

#### L.7 — Admin: Data Residency Configuration Screen — SG10

**Route:** `/admin/tenants/{id}/compliance`  
**Access:** Platform Admin only  
**Purpose:** Configure and verify data residency requirements for a tenant.

**Section 1 — Data Residency Setting:**
- Residency Zone (select): India 🇮🇳 | European Union 🇪🇺 | United States 🇺🇸 | Global (no restriction)
- Sensitive Data Category (multi-select): Health data | Financial data | Biometric data | General PII
- [Save Residency Settings] → PATCH `/admin/tenants/{id}/compliance`

**Section 2 — Infrastructure Compliance Status:**
- Current primary database region: [tag from infrastructure]
- Current backup region: [tag from infrastructure]
- CDN edge nodes: [list of active regions]
- Compliance status badge: ✅ Compliant | ⚠️ Review Required | 🔴 Non-Compliant
- Last verified: [timestamp]
- [Run Compliance Check] → triggers infrastructure tag scan

**Section 3 — Compliance History:**
- Table: Checked At | Status | Region Config | Verified By
- [Download Compliance Report] → PDF of current compliance state

**Note displayed:** *"Data residency enforcement requires infrastructure-level configuration. Contact your infrastructure team to ensure database and storage resources are tagged and deployed in the correct region. This screen reflects the current tag state only."*

---

#### L.8 — Organizer: Break-Glass Notification Screen — SG11

**Route:** Notification → deeplinks into `/organizer/events/{id}/platform-access-log?filter=break_glass`  
**Displayed as:** In-app notification + email

**Email notification template: `break_glass_organizer_alert`:**
- Subject: "Platform operator accessed your event data — [Event Name]"
- Body:
  - Date and time of access
  - Access type (e.g., "Attendee PII access")
  - Justification provided by the operator (full text)
  - Duration of access
  - "This access was approved by a second platform administrator. All actions taken during this session are logged and available in your Platform Access Log."
  - [View Platform Access Log] CTA
  - "If you did not expect this access or have concerns, contact your account manager at [email]."

**In-app notification:**
- Banner in organiser dashboard: "⚠️ A platform operator accessed your event data on [date]. [View details →]"
- Persists until organiser acknowledges

**Timing:** Notification fires when break-glass `status` changes to `approved` for a session where `event_id` matches the organiser's event. If no specific event is scoped (tenant-wide access), notification fires to all Organizer Admins in the tenant.

**Tier rule change (SG11 resolution):** Organizer break-glass notification is **mandatory at all tiers** — not optional and not enterprise-only. The spec's "enterprise tier optional" is upgraded to "all tiers required" in this plan.

---

### SCREEN GROUP M: PRIVACY AUDIT AND RETENTION

---

#### M.1 — Admin: Retention Enforcement Dashboard — SG3

**Route:** `/admin/tenants/{id}/retention`  
**Access:** Platform Admin only  
**Purpose:** Visibility into retention policy status and purge job execution across all events.

**Summary cards:**
- Events in active retention period: N
- Events past retention expiry (pending purge): N  
- Events purged (completed): N
- Next scheduled purge run: [timestamp]

**Events table:**
- Event Name
- Retention Days (from data policy)
- Event End Date
- Retention Expiry Date (calculated: end_date + retention_days)
- Status: `active` / `expiring_soon` (within 14 days) / `expired_pending_purge` / `purged`
- Last Purge Run
- Actions: [View Detail] [Force Purge Now] (Platform Admin, with confirmation)

**Purge Detail modal (per event):**
- Records scanned
- PII fields anonymised
- Attendee records affected
- Duration of job
- Audit entry link
- Any failures (partial success)

---

#### M.2 — Organizer: Retention Status Widget — SG3

**Placement:** C.2 Event Detail → Overview tab → new widget below onboarding checklist  
**Access:** Organizer Admin  
**Purpose:** Inform the organiser when their event data will be purged.

**Content:**
- Retention period set: [N days]
- Retention expiry date: [calculated date] *(if event is closed)*
- Status badge: `Active` / `Expiring in N days` / `Purge scheduled` / `Purged`
- [Change Retention Policy] → links to Data Policy tab (only available before event goes live)

**After purge:**
- Banner: "Event data was anonymised on [date] per your configured retention policy. Aggregate analytics have been preserved."

---

#### M.3 — Admin: Privacy Audit Log Screen — SG9

**Route:** `/admin/privacy-audit-log`  
**Access:** Platform Admin only  
**Purpose:** Dedicated view of all privacy-specific events across the platform, separate from the general `audit_logs`. Designed for regulatory production — a court or the Data Protection Board can compel this record and it must be clean and exportable.

**Layout:** Full-width table with sticky header

**Table columns:**
- Occurred At (UTC + IST)
- Tenant Name
- Event Name (if scoped)
- Actor Role (`platform_admin` / `organizer_action` / `attendee_action` / `system`)
- Action (categorised from the 15 defined action types in Part 15.1)
- Target Type + Target ID
- Metadata preview (expandable JSON)

**Filters:**
- Tenant (select, for cross-tenant admin view)
- Action type (multi-select from the 15 defined types)
- Actor role
- Date range (default: last 30 days)
- Event (optional)

**Export for regulatory production:**
- [Export as CSV] → `POST /admin/privacy-audit-log/export`
- [Export as JSON] → same endpoint, `format=json` param
- Export generates a timestamped, signed file. The export request itself is logged as a `privacy_audit_log` entry (action: `privacy_log_exported`, actor: the Platform Admin who requested it)
- Exports are not deletable and are stored permanently

**Organizer-scoped variant:**
- Route: `/organizer/events/{id}/privacy-audit-log`
- Same layout, pre-filtered to the organiser's event
- Actor role column shows only `organizer_action` and `system` — `platform_admin` and `attendee_action` entries are also visible but role is shown as a category, not an individual identity
- [Export] → `GET /events/{id}/privacy-audit-log` with export flag

**Empty state:** "No privacy events have been recorded for this scope. This log will populate as consent, export, DSR, and policy actions occur."

---

# ═══════════════════════════════════════════════════════════
# PART 14 — SOVEREIGNTY API ENDPOINTS
# ═══════════════════════════════════════════════════════════

### 14.1 Organizer Platform Access Log — SG1, SG8

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/events/{id}/platform-access-log` | Filtered audit view: Platform Admin + Ops User actions only | Organizer Admin |
| GET | `/events/{id}/platform-access-log/export` | Download CSV of platform access log | Organizer Admin |

**Query params for GET:**
- `action_type` (filter: data_access / policy_change / break_glass / export_action / config_change)
- `from` / `to` (date range, ISO 8601)
- `outcome` (accessed / denied / expired)
- `page` / `page_size`

**Response shape per log entry:**
```json
{
  "id": "uuid",
  "occurred_at": "ISO8601",
  "actor_role": "platform_admin | ops_user",
  "action_type": "break_glass | policy_change | data_access | ...",
  "target_resource": "string",
  "justification": "string | null",
  "session_duration_minutes": 47,
  "outcome": "accessed | denied | expired"
}
```
**Note:** `actor_user_id` is not exposed to Organizer Admin (protects platform personnel identity). Only role is shown.

---

### 14.2 Full Event Data Export — SG2

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| POST | `/events/{id}/full-export` | Request full portable event data export | Organizer Admin |
| GET | `/events/{id}/full-export/status` | Poll export job status | Organizer Admin |
| GET | `/events/{id}/full-export/download` | Get signed download URL (when ready) | Organizer Admin |
| GET | `/events/{id}/full-export/history` | List all previous full exports | Organizer Admin |

**Request body:**
```json
{
  "include": ["interactions", "consents", "leads_metadata", "event_config", "platform_access_log", "audit_trail", "attendee_data"],
  "format": "json | csv | zip"
}
```

**Constraints:**
- One active job per event at a time (409 if job already in progress)
- Download URL expires after 24 hours
- Download URL is single-use
- Audit events: `event.full_export_requested`, `event.full_export_ready`, `event.full_export_downloaded`

---

### 14.3 Data Subject Requests (DSR) — SG7

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| POST | `/attendee/privacy/dsr` | Submit export or delete request | Attendee (via session token) |
| GET | `/attendee/privacy/dsr` | Get status of own DSR requests | Attendee |
| GET | `/attendee/privacy/dsr/{id}/download` | Download own data export | Attendee |
| GET | `/events/{id}/privacy-requests` | List DSR requests for event | Organizer Admin |
| GET | `/events/{id}/privacy-requests/{id}` | DSR request detail | Organizer Admin |
| POST | `/events/{id}/privacy-requests/{id}/reject` | Reject DSR with reason (if manual mode) | Organizer Admin |
| GET | `/admin/dsr` | Platform-wide DSR dashboard | Platform Admin |

**DSR submission body:**
```json
{
  "request_type": "export | delete",
  "event_id": "uuid"
}
```

---

### 14.4 Tenant Offboarding — SG6

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| POST | `/admin/tenants/{id}/offboard` | Initiate offboarding workflow | Platform Admin |
| GET | `/admin/tenants/{id}/offboard/status` | Poll offboarding job status | Platform Admin |
| POST | `/admin/tenants/{id}/offboard/{id}/approve` | Second approver confirms deletion | Platform Admin (different user) |
| GET | `/admin/tenants/{id}/offboard/certificate` | Download deletion certificate | Platform Admin |

---

### 14.5 Retention Enforcement — SG3

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/admin/tenants/{id}/retention` | Retention status dashboard data | Platform Admin |
| POST | `/admin/events/{id}/retention/force-purge` | Manually trigger purge for event | Platform Admin (with confirmation) |
| GET | `/events/{id}/retention/status` | Retention status for organiser widget | Organizer Admin |

---

### 14.6 Data Residency Configuration — SG10

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/admin/tenants/{id}/compliance` | Get compliance/residency config | Platform Admin |
| PATCH | `/admin/tenants/{id}/compliance` | Update residency zone and data categories | Platform Admin |
| POST | `/admin/tenants/{id}/compliance/check` | Run infrastructure compliance check | Platform Admin |

---

### 14.7 Privacy Audit Log — SG9

| Method | Endpoint | Purpose | Who |
|--------|----------|---------|-----|
| GET | `/admin/privacy-audit-log` | Platform-wide privacy event log | Platform Admin |
| GET | `/events/{id}/privacy-audit-log` | Event-scoped privacy event log | Organizer Admin |
| POST | `/admin/privacy-audit-log/export` | Export privacy log for regulatory production | Platform Admin |

---

### 14.8 Sovereignty Webhook Events — SG5

New events added to the authoritative webhook catalogue (§8 extension):

| Event | Fires When | Payload Includes |
|-------|-----------|-----------------|
| `data_policy.changed` | Any `event_data_policies` field updated | event_id, field_changed, old_value, new_value, actor_role |
| `break_glass.accessed` | Break-glass session approved | event_id (if scoped), access_scope, justification, duration |
| `export.downloaded` | Any export file downloaded | event_id, export_type, export_id, actor_role |
| `retention.purge_completed` | Retention purge job completes for event | event_id, records_anonymised, completed_at |
| `dsr.submitted` | Attendee submits DSR | event_id, request_type (no attendee PII in payload) |
| `dsr.completed` | DSR request completed | event_id, request_type, completed_at |

---

# ═══════════════════════════════════════════════════════════
# PART 15 — SOVEREIGNTY IMPACT ANALYSIS
# ═══════════════════════════════════════════════════════════

### 15.1 Audit Service — SG1, SG8, SG9
**Impact: HIGH**

The existing `audit_logs` table records all actions but serves multiple purposes. Must be extended to:
- Add `actor_role_category` field (`internal_platform` vs `organizer_action` vs `system`) to every log entry, enabling the platform-access-log endpoint to filter without exposing actor identity
- Support the new `privacy_audit_log` table (SG9) as a required parallel log for all privacy-related events
- New audit event types for sovereignty events (see Phase 16 Step 16.1)

**New `privacy_audit_log` schema (SG9 — elevated from recommended to required):**
```sql
CREATE TABLE privacy_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'consent.captured','consent.revoked',
    'export.requested','export.approved','export.downloaded',
    'dsr.submitted','dsr.processing','dsr.completed','dsr.rejected',
    'break_glass.accessed','data_policy.changed',
    'retention.purge_executed','full_export.requested',
    'full_export.downloaded','attendee.anonymised',
    'tenant.offboarding_initiated','tenant.data_deleted'
  )),
  target_type TEXT,
  target_id UUID,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_privacy_audit_tenant_event ON privacy_audit_log(tenant_id, event_id, occurred_at DESC);
CREATE INDEX idx_privacy_audit_action ON privacy_audit_log(action, occurred_at DESC);
```

---

### 15.2 Export Service — SG2, SG3
**Impact: HIGH — significant new work**

The export service currently handles lead exports and sponsor exports. Must be extended with:
- Full event data export job (large, multi-table export with streaming/chunked generation)
- DSR export job (attendee-scoped privacy-safe export)
- Retention purge job (the primary new worker — see Phase 16)
- Signed expiring download URL generation for all three job types
- Download URL single-use enforcement (mark used after first download)

**Retention purge job specification:**
- Schedule: Nightly at 02:00 UTC (configurable per environment)
- Query: Find all events where `(event.end_at + data_policy.retention_days) <= now()` AND `event.retention_status != 'purged'`
- For each event:
  1. Set `event.retention_status = 'purging'`
  2. Null PII fields: `attendees.display_name`, `.email`, `.phone`, `.linkedin_url`, `.ip_address`, `.user_agent`
  3. Set `attendees.status = 'anonymised'`
  4. Null `interactions.raw_payload` (if stored)
  5. Preserve: `interactions.occurred_at`, `.stall_id`, `.consent_status` (anonymised form)
  6. Deny all future export requests for this event
  7. Set `event.retention_status = 'purged'`, `event.purged_at = now()`
  8. Write `privacy_audit_log` entry: `retention.purge_executed`
  9. Notify Organizer Admin via email: `retention_purge_completed` template
- On partial failure: set `retention_status = 'purge_failed'`, alert Platform Admin, retry next night

---

### 15.3 Notification Service — SG4, SG11
**Impact: MEDIUM**

New notification templates required:
- `data_policy_changed` — fires to Organizer Admin on any policy change (SG4)
- `break_glass_organizer_alert` — fires to Organizer Admin when break-glass approved on their event (SG11, all tiers)
- `retention_purge_completed` — fires to Organizer Admin when retention purge executes
- `dsr_export_ready` — fires to Attendee when DSR export is ready for download
- `dsr_delete_confirmed` — fires to Attendee when deletion is complete
- `offboarding_initiated` — fires to Organizer primary contact when offboarding starts
- `offboarding_deletion_reminder_14d` — T-14 reminder before auto-deletion
- `offboarding_deletion_reminder_3d` — T-3 reminder
- `offboarding_deletion_certificate` — deletion certificate delivery

---

### 15.4 Middleware Extensions — SG1
**Impact: LOW**

The platform-access-log endpoint must enforce that Organizer Admin can only read log entries scoped to their events. Extend `roleScopeMiddleware` to:
- For `GET /events/{id}/platform-access-log`: validate event_id is in organiser's `event_ids[]`
- Enforce `actor_role_category = 'internal_platform'` filter is always applied (organisers cannot see each other's actions)

---

### 15.5 Break-Glass Service Extension — SG11
**Impact: LOW**

Extend Phase 13's break-glass service (Step 13.1) to fire `break_glass_organizer_alert` notification after approval. The notification logic must:
- Identify the Organizer Admin(s) for the break-glass `event_id`
- If `event_id` is null (tenant-wide access): notify all Organizer Admins in the tenant
- Fire notification immediately on status change to `approved`

---

### 15.6 Database Migrations — All SG
**Impact: MEDIUM**

New tables and columns required:
- `privacy_audit_log` table (full schema in 15.1)
- `data_subject_requests` table (already defined in spec §10, confirm exists)
- `event.retention_status TEXT CHECK IN ('active','expiring_soon','expired_pending_purge','purging','purged','purge_failed')` column
- `event.purged_at TIMESTAMPTZ nullable` column
- `tenants.data_residency_zone TEXT CHECK IN ('india','eu','us','global') DEFAULT 'global'`
- `tenants.offboarding_status TEXT CHECK IN ('active','offboarding_initiated','data_exported','deleted')` column
- `tenants.offboarding_initiated_at TIMESTAMPTZ nullable`
- `audit_logs.actor_role_category TEXT CHECK IN ('internal_platform','organizer_action','attendee_action','system') NOT NULL`
- `export_requests.download_used BOOLEAN NOT NULL DEFAULT FALSE` (single-use download enforcement)
- `export_requests.download_used_at TIMESTAMPTZ nullable`

---

# ═══════════════════════════════════════════════════════════
# PART 16 — SOVEREIGNTY BUILD SEQUENCE (PHASES 14–18)
# ═══════════════════════════════════════════════════════════

### PHASE 14 — Sovereignty Database Migrations
*No dependencies on previous phases. Can run in parallel with Phase 1.*

**Step 14.1** — Create `privacy_audit_log` table (full schema from Part 15.1). After creation, apply DB-level append-only enforcement matching the existing `audit_logs` pattern from Migration 016:
```sql
REVOKE UPDATE, DELETE ON privacy_audit_log FROM app_runtime;
```
This ensures the privacy log cannot be tampered with at application level — the same protection already applied to `audit_logs`.

**Step 14.2** — Confirm `data_subject_requests` table exists per spec §10 schema. Create if absent.

**Step 14.3** — Add to `events` table:
- `retention_status TEXT NOT NULL DEFAULT 'active' CHECK (retention_status IN ('active','expiring_soon','expired_pending_purge','purging','purged','purge_failed'))`
- `purged_at TIMESTAMPTZ nullable`

**Step 14.4** — Add to `tenants` table:
- `data_residency_zone TEXT NOT NULL DEFAULT 'global' CHECK (data_residency_zone IN ('india','eu','us','global'))`
- `offboarding_status TEXT NOT NULL DEFAULT 'active' CHECK (offboarding_status IN ('active','offboarding_initiated','data_exported','deleted'))`
- `offboarding_initiated_at TIMESTAMPTZ nullable`

**Step 14.5** — Add to `audit_logs` table:
- `actor_role_category TEXT NOT NULL DEFAULT 'system' CHECK (actor_role_category IN ('internal_platform','organizer_action','attendee_action','system'))`

**Step 14.6** — Add to `export_requests` table:
- `download_used BOOLEAN NOT NULL DEFAULT FALSE`
- `download_used_at TIMESTAMPTZ nullable`

**Step 14.7** — Write migration + rollback scripts. Run on dev. Validate. Backfill `actor_role_category` on existing `audit_logs` rows based on `actor_user_id` role lookup.

---

### PHASE 15 — Sovereignty Backend Services
*Depends on: Phase 14 (DB), Phase 7 (Audit), Phase 13 (Break-Glass)*

**Step 15.1** — Implement platform-access-log endpoint (Part 14, §14.1):
- `GET /events/{id}/platform-access-log` — queries `audit_logs` filtered by `actor_role_category = 'internal_platform'` AND `entity_id` scoped to event resources
- `GET /events/{id}/platform-access-log/export` — streams CSV, fires `privacy_audit_log` entry

**Step 15.2** — Extend break-glass approval handler (Phase 13 Step 13.1) to fire `break_glass_organizer_alert` notification to all Organizer Admins scoped to the event (SG11)

**Step 15.3** — Implement data policy change notification hook (SG4):
- Extend `PATCH /events/{id}/data-policy` handler to fire `data_policy_changed` notification after every write
- Notification includes changed fields, old values, new values, actor role

**Step 15.4** — Implement full event data export endpoints (Part 14 §14.2):
- `POST /events/{id}/full-export` — creates export job, queues worker
- `GET /events/{id}/full-export/status` — polls job
- `GET /events/{id}/full-export/download` — validates single-use, returns signed URL
- `GET /events/{id}/full-export/history`

**Step 15.5** — Implement DSR endpoints (Part 14 §14.3):
- All attendee-facing DSR endpoints (submit, status, download)
- All organiser-facing DSR management endpoints

**Step 15.6** — Implement tenant offboarding endpoints (Part 14 §14.4):
- Full workflow: initiate → second-approver confirm → execute path A/B/C → certificate generation

**Step 15.7** — Implement retention status endpoints (Part 14 §14.5)

**Step 15.8** — Implement data residency configuration endpoints (Part 14 §14.6)

**Step 15.9** — Implement privacy audit log endpoints (Part 14 §14.7)

**Step 15.10** — Implement sovereignty webhook events — full dispatcher integration (SG5):

The 6 new sovereignty webhook event types defined in Part 14 §14.8 must be wired into the existing webhook infrastructure. The existing `webhook_subscriptions` + `webhook_deliveries` tables and dispatcher are already built. This step adds the 6 new event triggers:

- **`data_policy.changed`** — extend `PATCH /events/{id}/data-policy` handler: after successful write, call webhook dispatcher with payload `{event_id, field_changed, old_value, new_value, actor_role, occurred_at}`
- **`break_glass.accessed`** — extend break-glass approval handler (Phase 13 Step 13.1): after status → `approved`, dispatch webhook payload `{event_id (if scoped), access_scope, justification, session_duration_minutes, occurred_at}`
- **`export.downloaded`** — extend all export download handlers (`GET /exports/{id}/download`, `GET /events/{id}/full-export/download`): on signed-URL resolution, dispatch `{event_id, export_type, export_id, actor_role, occurred_at}`
- **`retention.purge_completed`** — extend Phase 16 Step 16.1 retention scheduler: after each event purge completes, dispatch `{event_id, records_anonymised, purged_at}`
- **`dsr.submitted`** — extend `POST /attendee/privacy/dsr`: after DSR record created, dispatch `{event_id, request_type, occurred_at}` — **no attendee PII in payload**
- **`dsr.completed`** — extend Phase 16 Step 16.3 DSR worker: after status → `completed`, dispatch `{event_id, request_type, completed_at}`

**Subscription validation:** Add the 6 new event names to the `allowed event names` CHECK constraint on `webhook_subscriptions.event_name`. Existing subscribers receive only events they subscribed to — no retroactive delivery.

**Signing:** All 6 new payloads follow the existing webhook signing contract (HMAC-SHA256 signature in `X-Webhook-Signature` header). No new signing mechanism required.

**Delivery:** Route through the existing webhook delivery queue and `webhook_deliveries` table. Retry logic is inherited from the existing dispatcher.

---

### PHASE 16 — Sovereignty Workers (Background Jobs)
*Depends on: Phase 14 (DB), Phase 15 (Services)*
*Note: Retention logic and DSR API routes are already implemented in the codebase. This phase adds autonomous scheduling and the missing worker components — it is completion work, not greenfield.*

**Step 16.1** — Implement retention purge scheduler (SG3):
- The `organizer-retention-run` route logic is already built — **do not rewrite it**
- Wrap it in a nightly cron worker at 02:00 UTC that:
  1. Queries all events where `(event.end_at + data_policy.retention_days) <= now()` AND `retention_status != 'purged'`
  2. Calls the existing retention execution logic per event
  3. Sets `events.retention_status = 'purged'` and `events.purged_at = now()` on success
  4. On partial failure: sets `retention_status = 'purge_failed'`, alerts Platform Admin, retries next cycle
  5. Writes `privacy_audit_log` entry: `retention.purge_executed`
  6. Fires `retention_purge_completed` notification to Organizer Admin
- The manual `organizer-retention-run` route remains as a Platform Admin override

**Step 16.2** — Implement full event data export worker (SG2):
- **New build** — no existing equivalent
- Triggered by `POST /events/{id}/full-export`
- Multi-table export: interactions, consents, export_requests metadata, event config, audit log (event-scoped), platform access log
- Streams to temporary encrypted storage, generates signed 24h single-use download URL
- Fires `event.full_export_ready` notification and `full_export.requested` privacy audit log entry

**Step 16.3** — Implement DSR export worker (SG7):
- DSR API routes (`attendee-dsr-create`, `organizer-dsr-complete`) already exist — **do not rewrite**
- Add the missing automated processing layer:
  - Worker polls `data_subject_requests` where `status = 'requested'` every 5 minutes
  - For `request_type = 'export'`: generate attendee-scoped privacy-safe export, set `status = 'processing'` then `'completed'`, fire `dsr_export_ready` notification
  - For `request_type = 'delete'`: execute anonymisation (fields defined in §21), attempt CRM deletion push, set status, fire `dsr_delete_confirmed` notification
  - Privacy audit log entry per completion: `dsr.completed`
- The existing `organizer-dsr-complete` manual route remains as override / exception handling

**Step 16.4** — Implement DSR CRM deletion push (SG7 sub-item):
- For delete DSRs where `crm_sync_jobs` records exist for the attendee: dispatch deletion request to the connected CRM
- Log outcome (success or failure) in `crm_sync_jobs` — do not block DSR completion on CRM failure
- Privacy audit log entry: note CRM deletion outcome

**Step 16.5** — Implement tenant offboarding deletion worker (SG6):
- **New build** — no existing equivalent
- Triggered by offboarding approval
- Executes full tenant data anonymisation across all events
- Generates deletion certificate PDF
- Fires `offboarding_deletion_certificate` notification
- Privacy audit log entry: `tenant.data_deleted`

**Step 16.6** — Implement retention expiry countdown job:
- Runs daily
- Updates `events.retention_status` to `expiring_soon` where expiry is within 14 days
- Updates to `expired_pending_purge` where expiry has passed but purge not yet run
- Notifies Organizer Admin on `expiring_soon` state transition

---

### PHASE 17 — Sovereignty Notification Templates
*Depends on: Phase 6 (Notification Service base), Phase 15*

**Step 17.1** — `data_policy_changed` — to Organizer Admin; fires on any data policy update
**Step 17.2** — `break_glass_organizer_alert` — to Organizer Admin; fires on break-glass approval (SG11)
**Step 17.3** — `retention_purge_completed` — to Organizer Admin; fires on successful nightly purge
**Step 17.4** — `retention_expiry_warning` — to Organizer Admin; fires at T-14 days before purge
**Step 17.5** — `dsr_export_ready` — to Attendee; fires when DSR export file is ready
**Step 17.6** — `dsr_delete_confirmed` — to Attendee; fires on successful anonymisation
**Step 17.7** — `offboarding_initiated` — to Organizer primary contact; fires on offboarding start
**Step 17.8** — `offboarding_deletion_reminder_14d` — to Organizer; T-14 day reminder
**Step 17.9** — `offboarding_deletion_reminder_3d` — to Organizer; T-3 day reminder
**Step 17.10** — `offboarding_deletion_certificate` — to Organizer; certificate delivery with PDF attachment

---

### PHASE 18 — Sovereignty Frontend Screens
*Depends on: Phase 15, Phase 8 (shared components)*

**Step 18.1** — Build L.1 Platform Access Log Screen (SG1, SG8)
**Step 18.2** — Add data policy change history widget to C.2 Data Policy tab (L.2 — SG4)
**Step 18.3** — Build L.3 Full Event Data Export Screen (SG2)
**Step 18.4** — Build L.4 Tenant Offboarding Workflow (SG6) — Platform Admin only
**Step 18.5** — Build L.5 Attendee DSR Flow screen (SG7)
**Step 18.6** — Build L.6 Organizer DSR Management Screen (SG7)
**Step 18.7** — Build L.7 Data Residency Configuration Screen (SG10) — Platform Admin only
**Step 18.8** — Build L.8 Break-Glass Organizer Notification (email template + in-app banner — SG11)
**Step 18.9** — Build M.1 Retention Enforcement Dashboard (SG3) — Platform Admin only
**Step 18.10** — Add M.2 Retention Status Widget to C.2 Overview tab (SG3)
**Step 18.11** — Build M.3 Privacy Audit Log Screen — Platform Admin view at `/admin/privacy-audit-log` and organizer-scoped view at `/organizer/events/{id}/privacy-audit-log` (SG9)
**Step 18.12** — Wire sovereignty webhook subscription UI: extend H.1 API Clients / webhook settings screen to display the 6 new sovereignty event types as subscribable options (SG5)

---

# ═══════════════════════════════════════════════════════════
# PART 17 — SOVEREIGNTY QA TEST CASES (Steps 12.43–12.68)
# ═══════════════════════════════════════════════════════════

These add to the existing 42 test cases in Phase 12.

#### Platform Access Log (SG1, SG8)

**Step 12.43** — Platform Admin takes a break-glass action on Event A → entry appears in Event A's Platform Access Log → Organizer Admin for Event A can read the entry with role, action, justification, and duration

**Step 12.44** — Organizer Admin for Event A attempts to view Event B's Platform Access Log → 403 EVENT_SCOPE_FORBIDDEN

**Step 12.45** — Platform Admin action on Event A does NOT appear in Event A's regular audit tab (action tab shows only organizer-initiated actions) — the two views are correctly separated

**Step 12.46** — Organizer Admin downloads Platform Access Log CSV → download itself appears as a new entry in the privacy_audit_log

#### Data Policy Notification (SG4)

**Step 12.47** — Organizer Admin changes `vendor_exports_enabled` from true to false → notification email fires to Organizer Admin within 60 seconds with field, old value, new value, actor

**Step 12.48** — Platform Admin changes same field → notification fires to Organizer Admin, row in data policy change history widget highlighted amber with "Changed by Platform Operator" label

#### Full Event Data Export (SG2)

**Step 12.49** — Organizer requests full export → job enters processing → email notification received → download link works → all 7 data categories present in export ZIP

**Step 12.50** — Download link used once → second attempt returns 410 Gone

**Step 12.51** — Organizer requests second full export while first is still processing → 409 Conflict returned

**Step 12.52** — Full export generated on event with some non-consented interactions → non-consented attendee fields are anonymised in export; consented fields are present

#### DSR Workflow (SG7) — Worker and Attendee UI completion
*Note: DSR API routes are already built. These tests validate the new automated worker and attendee UI.*

**Step 12.53** — Attendee submits export request via new self-service UI → DSR record created → **automated worker processes within 5 minutes without organiser intervention** → export file generated → notification email sent → attendee downloads file → file contains only own data; vendor notes/scores excluded

**Step 12.54** — Attendee submits delete request via self-service UI → **automated worker anonymises PII fields** → vendor lead inbox shows "Anonymous Visitor" → attendee profile page shows anonymised state — no manual organiser API call required

**Step 12.55** — Attendee submits delete request → CRM push deletion attempted for previously synced records → outcome logged in `crm_sync_jobs`; DSR completes regardless of CRM outcome; outcome visible in privacy_audit_log

**Step 12.56** — Organizer views DSR management screen → completed requests show data categories and timing → requests processed automatically; organiser only needs to act in manual-approval mode

#### Retention Purge (SG3) — Scheduler addition
*Note: Retention logic (`organizer-retention-run`) is already built. This tests the new autonomous scheduler.*


**Step 12.57** — Event with `retention_days = 30` is closed → 30 days later nightly job fires → PII fields anonymised → `event.retention_status = 'purged'` → Organizer Admin receives `retention_purge_completed` email → M.2 widget shows "Purged" state

**Step 12.58** — Event enters `expiring_soon` state (14 days to purge) → Organizer Admin receives `retention_expiry_warning` notification

**Step 12.59** — Force purge triggered by Platform Admin → same anonymisation logic executes → audit entry created

**Step 12.60** — Export request made against a purged event → 403 returned with reason "Event data has been purged per retention policy"

#### Break-Glass Organizer Notification (SG11)

**Step 12.61** — Platform Admin A requests break-glass for Event B → Platform Admin B approves → Organizer Admin for Event B receives in-app banner and email notification with justification text within 60 seconds of approval

**Step 12.62** — Platform Admin requests tenant-wide break-glass (no specific event) → all Organizer Admins in the tenant receive notification

**Step 12.63** — Organizer Admin notification links to Platform Access Log filtered to break_glass entries

#### Tenant Offboarding (SG6)

**Step 12.64** — Platform Admin initiates offboarding (Option A) → second admin approves → full export generated → organiser confirms receipt → deletion job executes → deletion certificate PDF delivered to organiser → tenant status = `deleted`

**Step 12.65** — Organiser attempts to login after tenant deletion → 404 tenant not found

**Step 12.66** — Option C: grace period offboarding → T-14 and T-3 reminder emails fire correctly → after grace period auto-deletion executes

#### Data Residency (SG10)

**Step 12.67** — Tenant residency set to `india` → compliance check run → result shows current infrastructure region → non-compliant state generates ⚠️ badge

#### Sovereignty Webhooks (SG5)

**Step 12.69** — Organizer subscribes to `data_policy.changed` webhook → Organizer updates `vendor_exports_enabled` → webhook fires within 60 seconds → payload contains `field_changed`, `old_value`, `new_value`, `actor_role`; payload is HMAC-signed correctly

**Step 12.70** — Platform Admin activates break-glass → `break_glass.accessed` webhook fires to all subscribers → payload contains `access_scope`, `justification`, session details; **no attendee PII in payload**

**Step 12.71** — Vendor downloads an export → `export.downloaded` webhook fires → payload contains `event_id`, `export_type`, `actor_role`

**Step 12.72** — Retention purge job completes for an event → `retention.purge_completed` webhook fires → payload contains `event_id`, `records_anonymised`, `purged_at`

**Step 12.73** — Attendee submits DSR request → `dsr.submitted` webhook fires → payload contains `event_id`, `request_type`; **attendee identity is not in the payload**

**Step 12.74** — Subscriber with only `interaction.created` subscription does **not** receive any sovereignty webhook events — subscription scoping is respected

**Step 12.75** — Attempt to subscribe to an event name not in the allowed list → `webhook_subscriptions` CHECK constraint rejects the insert → API returns 422

#### Privacy Audit Log (SG9)

**Step 12.76** — Every sovereignty action from Steps 12.43–12.75 produces a corresponding entry in `privacy_audit_log` with correct `action`, `actor_role`, `tenant_id`, `event_id` (where applicable), and `occurred_at`

**Step 12.77** — Platform Admin views M.3 Privacy Audit Log Screen → all 15 action types are filterable → date range filter works → results are sorted newest-first

**Step 12.78** — Platform Admin exports privacy audit log as CSV → export file is generated → the export action itself appears as a new `privacy_log_exported` entry in the log → the export file is not deletable

**Step 12.79** — Organizer Admin views event-scoped `/organizer/events/{id}/privacy-audit-log` → sees only entries for their event → `platform_admin` entries are visible as role category, not individual identity → Organizer Admin for a different event cannot access this view (403)

**Step 12.80** — Attempt to DELETE or UPDATE a `privacy_audit_log` row directly at DB level (simulating app_runtime user) → operation is rejected by DB-level REVOKE constraint (same pattern as `audit_logs` Migration 016)

---

# ═══════════════════════════════════════════════════════════
# PART 18 — UPDATED DEPENDENCY MAP (COMPLETE)
# ═══════════════════════════════════════════════════════════

```
Phase 1 (DB: Users/RBAC/Auth)         Phase 14 (DB: Sovereignty)
        ↓                                       ↓
Phase 2 (Auth Extensions) ──────────────────────────────────────┐
        ↓                                                        ↓
Phase 3 (User/Org API)    Phase 4 (Event API)    Phase 5 (Middleware + SG1 extension)
        ↓         ↓               ↓
Phase 6 (Notifications base)   Phase 7 (Audit + Expiry Job)
                   ↓                      ↓
         Phase 13 (Break-Glass + Device + API Client backend)
                   ↓                      ↓
         Phase 15 (Sovereignty Services — SG1-SG11)
                   ↓
         Phase 16 (Sovereignty Workers — Purge, DSR, Offboarding)
                   ↓
         Phase 17 (Sovereignty Notification Templates)
                   ↓
         Phase 8 (Shared UI Components)
              ↓                   ↓
Phase 9 (Admin Panel)   Phase 10 (Organizer UI + Sovereignty screens)
              ↓                   ↓
        Phase 11 (Post-Login Routing)
                   ↓
         Phase 18 (Sovereignty Frontend Screens)
                   ↓
        Phase 12 (QA — 68 test cases total)
```

---

# ═══════════════════════════════════════════════════════════
# PART 19 — COMPLETE WHAT-MUST-NOT-CHANGE CONSTRAINTS
# ═══════════════════════════════════════════════════════════

All 10 original constraints from Part 11 remain in force. The following 6 additional constraints apply to the sovereignty layer:

**11. Organizer audit view is read-only and unfiltered by Platform Admin.** The `GET /events/{id}/platform-access-log` response is generated directly from `audit_logs` filtered by `actor_role_category`. No Platform Admin action may modify the `actor_role_category` field retroactively. The organiser receives the raw log.

**12. Break-glass organizer notification fires at all tiers.** The spec's "enterprise tier optional" is superseded. Every break-glass approval that scopes to an event must notify the event's Organizer Admins. This applies at all pricing tiers and cannot be disabled by Platform Admin configuration.

**13. DSR delete is irreversible.** Once a DSR delete request enters `processing` status, it cannot be cancelled. The anonymisation worker must complete or fail — it cannot be stopped mid-execution. A failed DSR delete triggers an alert and must be retried; it cannot be dismissed.

**14. Retention purge does not delete audit logs or privacy_audit_log.** Audit trails are retained indefinitely regardless of `retention_days`. The purge job must explicitly exclude `audit_logs` and `privacy_audit_log` rows from deletion.

**15. Download URLs are single-use.** All export download URLs (full event export, DSR export, lead export) must be marked used on first access. A second access returns 410 Gone. This applies to signed URLs generated by all export types.

**16. Deletion certificate is permanent record.** Once generated, the deletion certificate PDF must be stored in platform records for a minimum of 7 years and must be retrievable by Platform Admin regardless of tenant deletion status.

---

# ═══════════════════════════════════════════════════════════
# COMPLETE PLAN SUMMARY
# ═══════════════════════════════════════════════════════════

| Dimension | Count |
|-----------|-------|
| Total gaps addressed (RBAC + Sovereignty) | 31 (G1–G20 + SG1–SG11) |
| Screen groups | 13 (A–M) |
| Screen specifications | 48 (added M.3 Privacy Audit Log) |
| Build phases | 18 |
| API endpoint groups | 14 |
| New API endpoints | 61 |
| New audit event types | 43 (29 RBAC + 14 Sovereignty) |
| New notification templates | 16 (6 RBAC + 10 Sovereignty) |
| New background workers | 6 (2 completions of partial builds; 4 new) |
| QA test cases | 79 (67 carried forward + 12 new for SG5 + SG9; original 12.68 superseded by 12.76–12.80) |
| Immutable constraints | 17 |
| **Sovereignty controls — fully built (codebase verified)** | **9** |
| **Sovereignty controls — partially built (codebase verified)** | **2 (DSR worker; retention scheduler)** |
| **Sovereignty controls — not built, now fully specced** | **7 (all addressed in Phases 14–18)** |

### Complete Coverage Verification — 7 Not-Built Items

| Gap | DB Migration | Backend Service | Worker | Notification | Frontend Screen | QA Tests |
|-----|-------------|----------------|--------|-------------|----------------|---------|
| SG1 Platform access log | Step 14.5 | Step 15.1 | — | — | Step 18.1 | 12.43–12.46 |
| SG2 Full data portability | Step 14.6 | Step 15.4 | Step 16.2 | Step 17.x | Step 18.3 | 12.49–12.52 |
| SG4 Policy change notification | — | Step 15.3 | — | Step 17.1 | Step 18.2 | 12.47–12.48 |
| SG5 Sovereignty webhooks | Step 14.7 | Step 15.10 (detailed) | — | — | Step 18.12 | 12.69–12.75 |
| SG6 Tenant offboarding | Step 14.4 | Step 15.6 | Step 16.5 | Steps 17.7–17.10 | Step 18.4 | 12.64–12.66 |
| SG8 Platform action audit view | Step 14.5 | Step 15.1 | — | — | Step 18.1 (shared) | 12.43–12.46 |
| SG9 Privacy audit log table | Step 14.1 (+REVOKE) | Step 15.9 | — | — | Step 18.11 | 12.76–12.80 |
| SG10 Data residency config | Step 14.4 | Step 15.8 | — | — | Step 18.7 | 12.67 |
| SG11 Break-glass org notification | — | Step 15.2 | — | Step 17.2 | Step 18.8 | 12.61–12.63 |

> ✅ Every not-built item has coverage across DB, backend, worker (where required), notification (where required), and frontend layers. No sovereignty gap is addressed in only one layer.

### Build Effort Reality Check (Updated)

- **9 controls already built** — core trust architecture is solid; no changes needed
- **2 partial builds (SG3 + SG7)** — logic exists; add scheduler + worker + attendee UI. Estimated: 3–5 days
- **7 net new builds** — fully specced. Priority order based on DPDP exposure:
  1. SG11 (break-glass notification) — single hook extension, 1 day
  2. SG4 (policy change notification) — single hook + template, 1 day
  3. SG9 (privacy_audit_log table) — DB migration + write hooks + screen, 2–3 days
  4. SG1/SG8 (platform access log) — DB column backfill + endpoint + screen, 2–3 days
  5. SG2 (full data portability export) — export worker + screen, 3–4 days
  6. SG5 (sovereignty webhooks) — 6 dispatcher hooks into existing infrastructure, 2 days
  7. SG6 (tenant offboarding) — full workflow, most complex, 5–7 days
  8. SG10 (data residency) — configuration layer + infra coordination, 3–5 days

---

*End of plan — v4 (final). Codebase-verified. All 7 not-built sovereignty items fully addressed across DB, backend, worker, notification, and frontend layers. 18 build phases, 13 screen groups (A–M), 48 screen specs, 79 QA test cases, 17 immutable constraints. DPDP-aligned.*
