# Commercial Partner Governance

This document closes the mandatory production scope for Deferred/Gap Step 1 in the RTM action plan.

Covered RTM items: RTM-0090, RTM-0091, RTM-0738, RTM-0739, RTM-0742, RTM-0743, RTM-0747, RTM-0750, RTM-0751.

## Production Rules

- Partner types are fixed to `referrer`, `channel_partner`, and `delivery_ecosystem_partner`.
- Partners receive commercial status updates only unless a platform admin explicitly provisions platform access to an active local OIDC-mapped user.
- Commercial status-only partners do not receive organizer dashboards, vendor leads, sponsor PII, or raw attendee data.
- Commercial communication must position the platform as exhibitor ROI, sponsor revenue, and measurable engagement, not NFC novelty or AI novelty.
- Deal pipeline stages are fixed to `lead_added`, `contacted`, `replied`, `call_scheduled`, `demo_done`, `proposal_sent`, `negotiation`, `closed_won`, and `closed_lost`.
- Every commercial deal must include `stage`, `next_action`, and `next_action_at`.
- Offer structures are fixed to `organizer_paid`, `sponsor_funded`, and `mixed`.
- Pricing discounts, pricing exceptions, and partner payout exceptions require `founder` or `product_owner` approval.
- Partner payouts are tracked from pending through approved/paid state and cannot be marked paid without `client_payment_received_at`.
- Demo SOP always includes tap demonstration, vendor ROI, sponsor reporting, consent/export/masking/break-glass trust controls, and organizer data-sensitivity objection handling.

## API Coverage

Platform-admin-only routes:

- `GET /admin/commercial/governance`
- `GET /admin/commercial/partners`
- `POST /admin/commercial/partners`
- `PATCH /admin/commercial/partners/:partnerId`
- `POST /admin/commercial/partners/:partnerId/status-updates`
- `GET /admin/commercial/deals`
- `POST /admin/commercial/deals`
- `PATCH /admin/commercial/deals/:dealId`
- `GET /admin/commercial/payouts`
- `POST /admin/commercial/payouts`
- `PATCH /admin/commercial/payouts/:payoutId`
- `GET /admin/commercial/approvals`
- `POST /admin/commercial/approvals`

## Persistence

Implemented tables:

- `commercial_partners`
- `commercial_deals`
- `commercial_partner_payouts`
- `commercial_approvals`
- `commercial_partner_status_updates`

The Postgres migration applies tenant RLS and grants runtime read/write access only through the application role. The in-memory repository mirrors the same model for local/demo tests.

## Verification

Automated coverage is in `apps/api/test/foundation.test.mjs` under:

`platform admin commercial governance covers mandatory Deferred/Gap Step 1 controls`

The test verifies non-admin denial, fixed governance reference data, explicit partner access provisioning, ROI-positioning acknowledgement before deal creation, pricing exception approver limits, payout paid-state blocking until client payment receipt, partner status-only updates, governance summary counts, and audit logging.
