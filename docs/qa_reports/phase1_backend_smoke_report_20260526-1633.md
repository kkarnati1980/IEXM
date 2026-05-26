# Phase 1 Backend Smoke Report

**Run at:** 2026-05-26 16:33:12
**API:** https://codex-api-production-064f.up.railway.app
**Mode:** DRY-RUN

| Total | Passed | Failed | Skipped |
|---|---|---|---|
| 34 | 2 | 5 | 27 |

| Item | Description | Result | Notes |
|---|---|---|---|
| A1 | Cross-org isolation | ❌ FAIL | Expected 403, got 401 |
| A2 | Invalid logo_url http:// | ⊘ SKIP | dry-run |
| A3 | Invalid logo_url javascript: | ⊘ SKIP | dry-run |
| A4 | Description >5000 chars | ⊘ SKIP | dry-run |
| A5 | Industry >80 chars | ⊘ SKIP | dry-run |
| 1.5 | GET social-links | ❌ FAIL | Expected 200, got 401 |
| 1.6a | PUT social-links 2 entries | ⊘ SKIP | dry-run |
| 1.6b | PUT social-links prefilled_message | ⊘ SKIP | dry-run |
| 1.6c | Invalid channel tiktok | ⊘ SKIP | dry-run |
| 1.6d | Social links >8 entries | ⊘ SKIP | dry-run |
| 1.6e | Social link http:// URL | ⊘ SKIP | dry-run |
| 1.6f | Social link javascript: URL | ⊘ SKIP | dry-run |
| 1.1 | GET vendor profile | ❌ FAIL | Expected 200, got 401. Body: { |
| 1.2a | PATCH save draft — profile.id UUID | ⊘ SKIP | dry-run |
| 1.2b | PATCH save draft — item.id UUID | ⊘ SKIP | dry-run |
| 1.2c | PATCH save draft — state=draft | ⊘ SKIP | dry-run |
| 1.2d | PATCH save draft — industry persists | ⊘ SKIP | dry-run |
| 1.2e | PATCH save draft — HTML stripped from display_name | ⊘ SKIP | dry-run |
| 1.2f | PATCH save draft — HTML stripped from description | ⊘ SKIP | dry-run |
| 1.3a | PATCH submit 200 (was 500) | ⊘ SKIP | dry-run |
| 1.3b | PATCH submit state=submitted | ⊘ SKIP | dry-run |
| 1.3c | PATCH submit submitted_at non-null | ⊘ SKIP | dry-run |
| 1.7a | Claim transition | ⊘ SKIP | no item ID — 1.3 skipped or failed |
| 1.7b | Self-approval guard | ⊘ SKIP | no item ID |
| 1.7c | Reject without note | ⊘ SKIP | no item ID |
| 1.7d | Approve transition | ⊘ SKIP | no item ID |
| 1.7e | Published pointer check | ⊘ SKIP | no item ID |
| 1.8a-name | Public endpoint display_name | ❌ FAIL | display_name is null/empty |
| 1.8a-ind | Public endpoint industry field | ❌ FAIL | industry is null/empty — regression: check vendor-profile-get route payload |
| 1.8a-links | Public endpoint social_links is array | ✅ PASS |  |
| 1.8b | Public endpoint without tenant_id → 400 | ✅ PASS |  |
| 1.7f | Reject-with-note cycle | ⊘ SKIP | dry-run |
| 1.4a | DB: no null new_status in moderation_notes | ⊘ SKIP | DATABASE_URL not set — set to run psql assertions |
| 1.4b | DB: submit note has new_status=submitted | ⊘ SKIP | DATABASE_URL not set |
