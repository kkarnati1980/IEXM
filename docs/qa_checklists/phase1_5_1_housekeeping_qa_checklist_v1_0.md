# P2 Phase 1.5.1 — Housekeeping QA Checklist v1.0

**Date:** 2026-05-29  
**Phase:** 1.5.1 — Closure housekeeping (FIX A: /auth/me banner; FIX B: pre-push hook removal)

---

## 1. Normal vendor.html load (approver, /auth/me working)

- [ ] Start server: `REPOSITORY_BACKEND=memory node apps/api/src/server.mjs`
- [ ] Open vendor.html with approver token (`demo-vendor-approver-token` in localStorage)
- [ ] Expected: **No error banner**; Review tab injected; leads load normally
- [ ] Expected: Tab bar shows Leads / Profile / Review

## 2. vendor.html with /auth/me forced to fail (banner appears)

- [ ] Start server with postgres backend (no DB reachable): `node apps/api/src/server.mjs`
  OR temporarily return 500 from /auth/me any other way
- [ ] Open vendor.html with approver token
- [ ] Expected: **Amber banner** at top: "Couldn't load your profile. Some features may be hidden." with a **Retry** button
- [ ] Expected: Review tab does **NOT** appear (flags stayed at defaults)
- [ ] Expected: No JS error in console; page otherwise functional (leads, profile tabs work)
- [ ] Expected: Editor token also shows the banner (same path, same behaviour)

## 3. Retry button recovery

- [ ] With banner visible (from step 2), fix /auth/me (switch to memory backend)
- [ ] Click **Retry** on the banner
- [ ] Expected: Banner disappears; Review tab injects (for approver token); no duplicate tabs
- [ ] Expected: Clicking Retry again (already recovered) is idempotent — no second Review tab

## 4. Fast push (no pre-push hook)

- [ ] Make a trivial commit (e.g. whitespace)
- [ ] Run: `git push origin main`
- [ ] Expected: Push completes in **< 10 seconds** with no baseline-refresh output
- [ ] Expected: No "Spec or ICD change detected" message
- [ ] Expected: `--no-verify` is not needed

## 5. Explicit baseline refresh via npm script

- [ ] Run: `npm run refresh-baselines`
- [ ] Expected: Claude Code executes `/baseline`, writes `baseline_master_spec.md` and `baseline_ICD.md`, prints summary
- [ ] Expected: Script exits 0

---

## Verification C — USER ACTION REQUIRED (external)

**Cannot be auto-run — requires Railway psql credentials.**

```bash
make psql
# Inside psql:
SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';
```

**Expected:** 76  
**If not 76:** Report discrepancy; open follow-up spec update commit.
