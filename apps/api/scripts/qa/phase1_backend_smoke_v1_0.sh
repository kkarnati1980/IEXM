#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 Backend Smoke — Vendor Profile Core (CR-VP-01)
# Maps to QA Checklist §1 items 1.1–1.8 + extra validation cases
#
# Usage:
#   bash phase1_backend_smoke_v1_0.sh             # run all tests
#   bash phase1_backend_smoke_v1_0.sh --dry-run   # print what would run, no writes
#
# Required env vars:
#   VENDOR_TOKEN            bearer token for vendor editor (vendor_content_editor scope)
#   VENDOR_APPROVER_TOKEN   bearer token for approver (vendor_content_approver scope, different user)
#
# Optional env vars:
#   API_BASE_URL    default: https://codex-api-production-064f.up.railway.app
#   DATABASE_URL    if set, runs DB-level psql assertions (item 1.4); skipped if absent
#
# Items covered:
#   1.1   GET /vendors/:org/profile — response shape (200, profile/published/pending keys)
#   1.2a  PATCH save draft — profile.id is UUID (no nextId prefix)
#   1.2b  PATCH save draft — item.id is UUID
#   1.2c  PATCH save draft — item.state = draft
#   1.2d  PATCH save draft — industry field persists (regression: was silently dropped)
#   1.2e  PATCH save draft — HTML stripped from display_name
#   1.2f  PATCH save draft — HTML stripped from description
#   1.3a          PATCH submit=true — 200 (regression: was 500 null new_status)
#   1.3b          PATCH submit=true — item.state = submitted
#   1.3c          PATCH submit=true — submitted_at non-null
#   1.3b-integrity PATCH save-draft on submitted item → auto-transitions to draft (integrity fix)
#   1.4a  DB: no moderation_notes rows with null new_status (requires DATABASE_URL)
#   1.4b  DB: most recent submit note has new_status='submitted'
#   1.5   GET /vendors/:org/social-links — 200, social_links array
#   1.6a  PUT social-links — 200, 2 entries stored
#   1.6b  PUT social-links — prefilled_message preserved
#   1.6c  PUT social-links — invalid channel (tiktok) → 422
#   1.6d  PUT social-links — >8 entries → 422
#   1.6e  PUT social-links — http:// URL → 422
#   1.6f  PUT social-links — javascript: URL → 422
#   1.7a  Transition: submitted → under_review (claim) — 200, state correct
#   1.7b  Transition: reject without note → 422 (item state unchanged)
#   1.7c  Self-approval guard: vendor cannot approve own submission → 403
#   1.7d  Transition: under_review → approved — 200, state correct, decided_at non-null
#   1.7e  Published pointer after approve — published.id = item ID, pending = null
#   1.7f  Reject-with-note → 200, state = rejected (second draft cycle)
#   1.8a  GET /stalls/:id/vendor-profile — 200, display_name + industry + social_links
#   1.8b  GET /stalls/:id/vendor-profile (no tenant_id) → 400
#   A1    Cross-org isolation — vendor cannot access different org → 403
#   A2    Invalid logo_url (http://) → 422
#   A3    Invalid logo_url (javascript:) → 422
#   A4    Description >5000 chars → 422
#   A4b   Description 2001 chars (1 over limit boundary) → 422
#   A5    Industry >80 chars → 422
#
# Exit codes:
#   0  all items PASS (or SKIP)
#   1  one or more items FAIL
#   2  env var missing or script error
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=test-fixtures.sh
source "$SCRIPT_DIR/test-fixtures.sh"

# ── flags ─────────────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

# ── env validation ────────────────────────────────────────────────────────────
API_BASE_URL="${API_BASE_URL:-https://codex-api-production-064f.up.railway.app}"
missing=()
[[ -z "${VENDOR_TOKEN:-}" ]]          && missing+=("VENDOR_TOKEN")
[[ -z "${VENDOR_APPROVER_TOKEN:-}" ]] && missing+=("VENDOR_APPROVER_TOKEN")
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: Missing required env vars:" >&2
  for v in "${missing[@]}"; do
    echo "  export $v=<value>" >&2
  done
  echo "" >&2
  echo "  export VENDOR_TOKEN=demo-vendor-token" >&2
  echo "  export VENDOR_APPROVER_TOKEN=demo-vendor-approver-token" >&2
  exit 2
fi

# ── report state ──────────────────────────────────────────────────────────────
declare -a REPORT_ROWS=()
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
CURRENT_ITEM_ID=""
CURRENT_PROFILE_ID=""
RUN_TS="$(date '+%Y%m%d-%H%M')"

# ── colour ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── temp file for curl responses ──────────────────────────────────────────────
_CURL_TMP="$(mktemp)"
trap 'rm -f "$_CURL_TMP"' EXIT

# ── helpers ───────────────────────────────────────────────────────────────────

section() {
  echo ""
  echo -e "${CYAN}${BOLD}══ $1 ══${RESET}"
}

hr()      { echo "───────────────────────────────────────────────────────────"; }
info()    { echo -e "  ${CYAN}ℹ${RESET}  $*"; }
write_op(){ echo -e "  ${YELLOW}[WRITE]${RESET} $*"; }
read_op() { echo -e "  [READ]  $*"; }

# json_get <json_string> <python_expr_using_d>
# Uses stdin pipe to avoid triple-quote fragility with embedded quotes/special chars.
json_get() {
  local expr="$2"
  printf '%s' "$1" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  val = $expr
  print('' if val is None else str(val))
except Exception:
  print('')
" 2>/dev/null || echo ""
}

# has_key <json_string> <key>
has_key() {
  local key="$2"
  printf '%s' "$1" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  sys.exit(0 if '$key' in d else 1)
except Exception:
  sys.exit(1)
" 2>/dev/null
}

# curl_req <method> <path> [token] [body]
# Sets RESP_BODY (string) and RESP_STATUS (HTTP code string).
curl_req() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local url="${API_BASE_URL}${path}"
  local args=(-s -o "$_CURL_TMP" -w "%{http_code}" -X "$method")
  args+=(-H "Content-Type: application/json")
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
  [[ -n "$body" ]] && args+=(-d "$body")
  RESP_STATUS="$(curl "${args[@]}" "$url" 2>/dev/null)"
  RESP_BODY="$(cat "$_CURL_TMP")"
}

pass_item() {
  local id="$1" desc="$2" notes="${3:-}"
  echo -e "  ${GREEN}✅ PASS${RESET} [$id] $desc"
  REPORT_ROWS+=("$id|$desc|PASS|$notes")
  ((PASS_COUNT++)) || true
}

fail_item() {
  local id="$1" desc="$2" notes="${3:-}"
  echo -e "  ${RED}❌ FAIL${RESET} [$id] $desc"
  [[ -n "$notes" ]] && echo -e "       ${RED}↳ $notes${RESET}"
  REPORT_ROWS+=("$id|$desc|FAIL|$notes")
  ((FAIL_COUNT++)) || true
}

skip_item() {
  local id="$1" desc="$2" notes="${3:-}"
  echo -e "  ${YELLOW}⊘ SKIP${RESET} [$id] $desc${notes:+ ($notes)}"
  REPORT_ROWS+=("$id|$desc|SKIP|$notes")
  ((SKIP_COUNT++)) || true
}

assert_http() {
  # assert_http <expected_status> <actual_status>
  [[ "$1" == "$2" ]]
}

# UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (no prefix)
is_uuid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

# ── cleanup: reset pending state before run for idempotency ───────────────────

cleanup() {
  section "CLEANUP — resetting pending state (idempotency)"

  curl_req GET "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN"
  local state
  state="$(json_get "$RESP_BODY" "d.get('pending', {}).get('state', '') if d.get('pending') else ''")"
  local pending_id
  pending_id="$(json_get "$RESP_BODY" "d.get('pending', {}).get('id', '') if d.get('pending') else ''")"

  if [[ -z "$state" || "$state" == "" ]]; then
    info "No pending item — starting fresh"
  elif [[ "$state" == "draft" ]]; then
    info "Existing draft found — will overwrite with PATCH (idempotent)"
  elif [[ "$state" == "submitted" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      info "[dry-run] Would withdraw submitted item $pending_id"
    else
      write_op "Withdrawing submitted item $pending_id"
      curl_req POST "/moderation-items/${pending_id}/transition" "$VENDOR_TOKEN" '{"to_state":"withdrawn"}'
      if assert_http 200 "$RESP_STATUS"; then
        info "Withdrawn OK"
      else
        echo -e "  ${RED}WARNING: Could not withdraw submitted item (status $RESP_STATUS). Some write tests may be skipped.${RESET}"
      fi
    fi
  elif [[ "$state" == "under_review" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      info "[dry-run] Would reject under_review item $pending_id"
    else
      write_op "Rejecting under_review item $pending_id to reset state"
      curl_req POST "/moderation-items/${pending_id}/transition" "$VENDOR_APPROVER_TOKEN" \
        '{"to_state":"rejected","note":"Smoke test cleanup — resetting state"}'
      if assert_http 200 "$RESP_STATUS"; then
        info "Rejected OK — state reset"
      else
        echo -e "  ${RED}WARNING: Could not reject under_review item (status $RESP_STATUS).${RESET}"
      fi
    fi
  else
    info "Pending item in terminal/other state ($state) — will create new draft"
  fi
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION A — Validation / negative tests (safe before state changes)
# ─────────────────────────────────────────────────────────────────────────────

smoke_A1_cross_org_isolation() {
  hr; echo "  A1: Cross-org isolation"
  read_op "GET /vendors/${QA_OTHER_ORG}/profile with VENDOR_TOKEN (org=$QA_VENDOR_ORG)"
  curl_req GET "/vendors/${QA_OTHER_ORG}/profile" "$VENDOR_TOKEN"
  if assert_http 403 "$RESP_STATUS"; then
    pass_item "A1" "Cross-org: vendor cannot access other org profile → 403"
  else
    fail_item "A1" "Cross-org isolation" "Expected 403, got $RESP_STATUS"
  fi
}

smoke_A2_invalid_logo_http() {
  hr; echo "  A2: Invalid logo_url (http://) → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A2" "Invalid logo_url http://" "dry-run"; return; fi
  write_op "PATCH with http:// logo_url"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"logo_url":"http://insecure.example.com/logo.png"}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "A2" "Invalid logo_url (http://) rejected → 422"
  else
    fail_item "A2" "Invalid logo_url (http://)" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A3_invalid_logo_javascript() {
  hr; echo "  A3: Invalid logo_url (javascript:) → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A3" "Invalid logo_url javascript:" "dry-run"; return; fi
  write_op "PATCH with javascript: logo_url"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"logo_url":"javascript:alert(1)"}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "A3" "Invalid logo_url (javascript:) rejected → 422"
  else
    fail_item "A3" "Invalid logo_url (javascript:)" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A4_description_length() {
  hr; echo "  A4: Description >5000 chars → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A4" "Description >5000 chars → 422" "dry-run"; return; fi
  local long_desc
  long_desc="$(python3 -c "print('A' * 5001)")"
  write_op "PATCH with 5001-char description"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    "{\"description\":\"${long_desc}\"}"
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "A4" "Description >5000 chars rejected → 422"
  else
    fail_item "A4" "Description >5000 chars" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A4b_description_boundary() {
  hr; echo "  A4b: Description 2001 chars (1 over limit) → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A4b" "Description 2001 chars → 422" "dry-run"; return; fi
  local boundary_desc
  boundary_desc="$(python3 -c "print('B' * 2001)")"
  write_op "PATCH with 2001-char description (1 over 2000-char limit)"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    "{\"description\":\"${boundary_desc}\"}"
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "A4b" "Description 2001 chars (boundary) rejected → 422"
  else
    fail_item "A4b" "Description 2001 chars boundary" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A5_industry_too_long() {
  hr; echo "  A5: Industry >80 chars → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A5" "Industry >80 chars" "dry-run"; return; fi
  local long_ind
  long_ind="$(python3 -c "print('B' * 81)")"
  write_op "PATCH with 81-char industry"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    "{\"industry\":\"${long_ind}\"}"
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "A5" "Industry >80 chars rejected → 422"
  else
    fail_item "A5" "Industry >80 chars" "Expected 422, got $RESP_STATUS"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.1 — GET profile
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_1_get_profile_keys() {
  hr; echo "  1.1: GET /vendors/:org/profile — response shape"
  read_op "GET /vendors/${QA_VENDOR_ORG}/profile"
  curl_req GET "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN"
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.1" "GET vendor profile" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    return
  fi
  local missing_keys=()
  for key in profile published pending; do
    if ! has_key "$RESP_BODY" "$key"; then missing_keys+=("$key"); fi
  done
  if [[ ${#missing_keys[@]} -eq 0 ]]; then
    pass_item "1.1" "GET vendor profile → 200, profile/published/pending keys present"
  else
    fail_item "1.1" "GET vendor profile" "Missing keys: ${missing_keys[*]}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.2 — PATCH save draft
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_2_patch_save_draft() {
  hr; echo "  1.2: PATCH /vendors/:org/profile — save draft"
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_item "1.2a" "PATCH save draft — profile.id UUID" "dry-run"
    skip_item "1.2b" "PATCH save draft — item.id UUID"    "dry-run"
    skip_item "1.2c" "PATCH save draft — state=draft"     "dry-run"
    skip_item "1.2d" "PATCH save draft — industry persists" "dry-run"
    skip_item "1.2e" "PATCH save draft — HTML stripped from display_name" "dry-run"
    skip_item "1.2f" "PATCH save draft — HTML stripped from description"  "dry-run"
    return
  fi

  write_op "PATCH with full payload (HTML in display_name + description for strip regression)"
  # Single-quoted JSON body passed as string — special chars safe in -d
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"display_name":"<b>QA Smoke v1.0</b>","tagline":"Built for smoke testing","description":"<em>QA</em> smoke test description.","website_url":"https://example.com","industry":"SmokeTestIndustry","social_links":[{"channel":"linkedin","url":"https://linkedin.com/company/smoke-test"}]}'
  echo "  Response status: $RESP_STATUS"

  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.2" "PATCH save draft" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    return
  fi

  # 1.2a — profile.id is UUID (regression: was nextId("vp-xxx") prefix format)
  local profile_id
  profile_id="$(json_get "$RESP_BODY" "d['profile']['id']")"
  if is_uuid "$profile_id"; then
    pass_item "1.2a" "profile.id is UUID (no nextId prefix) — '${profile_id:0:8}…'"
  else
    fail_item "1.2a" "profile.id UUID format" "Got: '$profile_id' — nextId() regression?"
  fi

  # 1.2b — item.id is UUID
  local item_id
  item_id="$(json_get "$RESP_BODY" "d['item']['id']")"
  if is_uuid "$item_id"; then
    pass_item "1.2b" "item.id is UUID — '${item_id:0:8}…'"
  else
    fail_item "1.2b" "item.id UUID format" "Got: '$item_id'"
  fi

  # 1.2c — state = draft
  local state
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" == "draft" ]]; then
    pass_item "1.2c" "item.state = draft"
  else
    fail_item "1.2c" "item.state = draft" "Got: '$state'"
  fi

  # 1.2d — industry field preserved (regression: was silently dropped)
  local industry
  industry="$(json_get "$RESP_BODY" "d['item']['payload']['industry']")"
  if [[ "$industry" == "SmokeTestIndustry" ]]; then
    pass_item "1.2d" "industry field persists in payload (regression: was silently dropped)"
  else
    fail_item "1.2d" "industry field persists" "Expected 'SmokeTestIndustry', got '$industry'"
  fi

  # 1.2e — HTML stripped from display_name
  local display_name
  display_name="$(json_get "$RESP_BODY" "d['item']['payload']['display_name']")"
  if [[ "$display_name" == "QA Smoke v1.0" ]]; then
    pass_item "1.2e" "HTML stripped from display_name (<b> tags removed)"
  else
    fail_item "1.2e" "HTML stripped from display_name" "Expected 'QA Smoke v1.0', got '$display_name'"
  fi

  # 1.2f — HTML stripped from description
  local description
  description="$(json_get "$RESP_BODY" "d['item']['payload']['description']")"
  if [[ "$description" == "QA smoke test description." ]]; then
    pass_item "1.2f" "HTML stripped from description (<em> tags removed)"
  else
    fail_item "1.2f" "HTML stripped from description" "Expected 'QA smoke test description.', got '$description'"
  fi

  # Capture IDs for subsequent tests
  CURRENT_PROFILE_ID="$profile_id"
  CURRENT_ITEM_ID="$item_id"
  info "Profile ID: $CURRENT_PROFILE_ID"
  info "Item ID:    $CURRENT_ITEM_ID"
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.5 — GET social-links
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_5_get_social_links() {
  hr; echo "  1.5: GET /vendors/:org/social-links"
  read_op "GET /vendors/${QA_VENDOR_ORG}/social-links"
  curl_req GET "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN"
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.5" "GET social-links" "Expected 200, got $RESP_STATUS"
    return
  fi
  local is_array
  is_array="$(printf '%s' "$RESP_BODY" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print('yes' if isinstance(d.get('social_links'), list) else 'no')
except Exception:
  print('no')
" 2>/dev/null || echo "no")"
  if [[ "$is_array" == "yes" ]]; then
    pass_item "1.5" "GET social-links → 200, social_links is array"
  else
    fail_item "1.5" "GET social-links" "social_links key missing or not an array. Body: $RESP_BODY"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.6 — PUT social-links (valid + negative)
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_6_put_social_links_valid() {
  hr; echo "  1.6: PUT /vendors/:org/social-links — valid payload"
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_item "1.6a" "PUT social-links 2 entries" "dry-run"
    skip_item "1.6b" "PUT social-links prefilled_message" "dry-run"
    return
  fi
  write_op "PUT social-links (linkedin + instagram with prefilled_message)"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"linkedin","url":"https://linkedin.com/company/smoke"},{"channel":"instagram","url":"https://instagram.com/smoke","prefilled_message":"Hello smoke!"}]}'
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.6a" "PUT social-links" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    fail_item "1.6b" "PUT social-links prefilled_message" "skipped due to 1.6a failure"
    return
  fi
  local count
  count="$(printf '%s' "$RESP_BODY" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print(len(d.get('item',{}).get('payload',{}).get('social_links',[])))
except Exception:
  print('0')
" 2>/dev/null || echo "0")"
  if [[ "$count" == "2" ]]; then
    pass_item "1.6a" "PUT social-links → 200, 2 entries stored"
  else
    fail_item "1.6a" "PUT social-links entry count" "Expected 2, got $count"
  fi
  local msg
  msg="$(printf '%s' "$RESP_BODY" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  links = d.get('item',{}).get('payload',{}).get('social_links',[])
  ig = [l for l in links if l.get('channel') == 'instagram']
  print(ig[0].get('prefilled_message','') if ig else '')
except Exception:
  print('')
" 2>/dev/null || echo "")"
  if [[ "$msg" == "Hello smoke!" ]]; then
    pass_item "1.6b" "PUT social-links → prefilled_message preserved on instagram"
  else
    fail_item "1.6b" "PUT social-links prefilled_message" "Expected 'Hello smoke!', got '$msg'"
  fi
}

smoke_1_6c_invalid_channel() {
  hr; echo "  1.6c: PUT social-links — invalid channel (tiktok) → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.6c" "Invalid channel tiktok" "dry-run"; return; fi
  write_op "PUT social-links with tiktok channel"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"tiktok","url":"https://tiktok.com/@acme"}]}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "1.6c" "Social links invalid channel (tiktok) → 422"
  else
    fail_item "1.6c" "Social links invalid channel" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_1_6d_max_8_entries() {
  hr; echo "  1.6d: PUT social-links — >8 entries → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.6d" "Social links >8 entries" "dry-run"; return; fi
  write_op "PUT social-links with 9 entries (length check before dedup)"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"linkedin","url":"https://a.com"},{"channel":"instagram","url":"https://b.com"},{"channel":"facebook","url":"https://c.com"},{"channel":"x","url":"https://d.com"},{"channel":"youtube","url":"https://e.com"},{"channel":"whatsapp","url":"https://f.com"},{"channel":"generic_1","url":"https://g.com"},{"channel":"generic_2","url":"https://h.com"},{"channel":"linkedin","url":"https://i.com"}]}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "1.6d" "Social links >8 entries rejected → 422"
  else
    fail_item "1.6d" "Social links >8 entries" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_1_6e_https_only_url() {
  hr; echo "  1.6e: PUT social-links — http:// URL → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.6e" "Social link http:// URL" "dry-run"; return; fi
  write_op "PUT social-links with http:// (non-https) URL"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"linkedin","url":"http://linkedin.com/company/insecure"}]}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "1.6e" "Social link http:// URL rejected → 422"
  else
    fail_item "1.6e" "Social link https-only enforcement" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_1_6f_javascript_url() {
  hr; echo "  1.6f: PUT social-links — javascript: URL → 422"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.6f" "Social link javascript: URL" "dry-run"; return; fi
  write_op "PUT social-links with javascript: URL"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"linkedin","url":"javascript:alert(1)"}]}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "1.6f" "Social link javascript: URL rejected → 422"
  else
    fail_item "1.6f" "Social link javascript: URL" "Expected 422, got $RESP_STATUS"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.3 — PATCH submit=true
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_3_patch_submit() {
  hr; echo "  1.3: PATCH /vendors/:org/profile — submit=true"
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_item "1.3a" "PATCH submit 200 (was 500)" "dry-run"
    skip_item "1.3b" "PATCH submit state=submitted" "dry-run"
    skip_item "1.3c" "PATCH submit submitted_at non-null" "dry-run"
    return
  fi
  write_op "PATCH with submit:true (regression: was 500 — null new_status in moderation_notes)"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"display_name":"QA Smoke v1.0","submit":true}'
  echo "  Response status: $RESP_STATUS"

  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.3a" "PATCH submit=true → 200" \
      "Got $RESP_STATUS. If 500 'null value in column new_status': recordModerationTransition() regression"
    fail_item "1.3b" "PATCH submit — state=submitted" "skipped: 1.3a failed"
    fail_item "1.3c" "PATCH submit — submitted_at non-null" "skipped: 1.3a failed"
    return
  fi
  pass_item "1.3a" "PATCH submit=true → 200 (no 500 regression)"

  local new_item_id
  new_item_id="$(json_get "$RESP_BODY" "d['item']['id']")"
  [[ -n "$new_item_id" ]] && CURRENT_ITEM_ID="$new_item_id"

  local state
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" == "submitted" ]]; then
    pass_item "1.3b" "PATCH submit → item.state = submitted"
  else
    fail_item "1.3b" "PATCH submit → item.state" "Expected 'submitted', got '$state'"
  fi

  local submitted_at
  submitted_at="$(json_get "$RESP_BODY" "d['item']['submitted_at']")"
  if [[ -n "$submitted_at" ]]; then
    pass_item "1.3c" "PATCH submit → submitted_at is non-null"
  else
    fail_item "1.3c" "PATCH submit → submitted_at non-null" "submitted_at is null/empty"
  fi
  info "Item ID after submit: $CURRENT_ITEM_ID"
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.3b-integrity — save-draft on submitted item → auto-transitions to draft
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_3_integrity() {
  hr; echo "  1.3b-integrity: PATCH save-draft on submitted item → 422 edit-lock (AP-6, Phase 1.5)"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.3b-integrity" "Edit-lock: save-draft on submitted item" "no item ID — 1.3 skipped or failed"
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_item "1.3b-integrity" "Edit-lock: save-draft on submitted item → 422" "dry-run"
    return
  fi

  write_op "PATCH save-draft on submitted item (Phase 1.5 AP-6 edit-lock: must 422, item stays submitted)"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"display_name":"QA Smoke v1.0 — integrity edit","submit":false}'

  if assert_http 422 "$RESP_STATUS"; then
    local lock_msg
    lock_msg="$(json_get "$RESP_BODY" "d.get('error','')")"
    if [[ "$lock_msg" == *"withdraw before editing"* ]]; then
      pass_item "1.3b-integrity" "Edit-lock: PATCH on submitted item → 422 with edit-lock message (AP-6)"
    else
      fail_item "1.3b-integrity" "Edit-lock: PATCH on submitted item → 422 body" \
        "Status was 422 but message wrong. Got: '$lock_msg'"
    fi
  else
    fail_item "1.3b-integrity" "Edit-lock: PATCH on submitted item → 422" \
      "Expected 422 (AP-6 edit-lock), got $RESP_STATUS. Body: $RESP_BODY"
  fi
  info "1.3b-integrity: item $CURRENT_ITEM_ID stays submitted (422 rejected edit) — downstream 1.7a proceeds"
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.7 — Transitions: claim, self-approval guard, reject-no-note, approve
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_7a_transition_claim() {
  hr; echo "  1.7a: POST /moderation-items/:id/transition — submitted → under_review"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7a" "Claim transition" "no item ID — 1.3 skipped or failed"
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7a" "Claim transition" "dry-run"; return; fi
  write_op "POST transition to_state=under_review (APPROVER_TOKEN)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"under_review"}'
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.7a" "Claim: submitted → under_review" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    return
  fi
  local state
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" == "under_review" ]]; then
    pass_item "1.7a" "Claim → item.state = under_review"
  else
    fail_item "1.7a" "Claim transition state" "Expected 'under_review', got '$state'"
  fi
}

smoke_1_7b_self_approval_guard() {
  hr; echo "  1.7b: Self-approval guard — vendor cannot approve own submission → 403"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7b" "Self-approval guard" "no item ID"
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7b" "Self-approval guard" "dry-run"; return; fi
  write_op "VENDOR_TOKEN attempts approve on item it edited (item: ${CURRENT_ITEM_ID:0:8}…)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_TOKEN" \
    '{"to_state":"approved"}'
  if assert_http 403 "$RESP_STATUS"; then
    pass_item "1.7b" "Self-approval guard: editor cannot approve own submission → 403"
  else
    fail_item "1.7b" "Self-approval guard" "Expected 403, got $RESP_STATUS. Body: $RESP_BODY"
  fi
}

smoke_1_7c_reject_no_note() {
  hr; echo "  1.7c: Reject without note → 422"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7c" "Reject without note" "no item ID"
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7c" "Reject without note" "dry-run"; return; fi
  write_op "POST transition to_state=rejected WITHOUT note (must 422, state unchanged)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"rejected"}'
  if assert_http 422 "$RESP_STATUS"; then
    pass_item "1.7c" "Reject without note → 422 (state unchanged in under_review)"
  else
    fail_item "1.7c" "Reject without note" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_1_7d_transition_approve() {
  hr; echo "  1.7d: POST /moderation-items/:id/transition — under_review → approved"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7d" "Approve transition" "no item ID"
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7d" "Approve transition" "dry-run"; return; fi
  write_op "POST transition to_state=approved (APPROVER_TOKEN)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"approved"}'
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.7d" "Approve transition" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    return
  fi
  local state decided_at
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  decided_at="$(json_get "$RESP_BODY" "d['item']['decided_at']")"
  if [[ "$state" == "approved" ]]; then
    pass_item "1.7d" "Approve → item.state = approved"
  else
    fail_item "1.7d" "Approve transition state" "Expected 'approved', got '$state'"
  fi
  if [[ -n "$decided_at" ]]; then
    pass_item "1.7d-decided" "Approve → decided_at is non-null"
  else
    fail_item "1.7d-decided" "decided_at non-null after approve" "decided_at is null/empty"
  fi
}

smoke_1_7e_published_pointer() {
  hr; echo "  1.7e: GET profile after approve — published pointer + pending=null"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7e" "Published pointer check" "no item ID"
    return
  fi
  read_op "GET /vendors/${QA_VENDOR_ORG}/profile"
  curl_req GET "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN"
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.7e" "Published pointer" "Expected 200, got $RESP_STATUS"
    return
  fi
  local published_id
  published_id="$(json_get "$RESP_BODY" "d.get('published', {}).get('id', '') if d.get('published') else ''")"
  local pending_val
  pending_val="$(json_get "$RESP_BODY" "str(d.get('pending'))")"
  if [[ "$published_id" == "$CURRENT_ITEM_ID" ]]; then
    pass_item "1.7e-pub" "published.id matches approved item ID"
  else
    fail_item "1.7e-pub" "published.id after approve" \
      "Expected '$CURRENT_ITEM_ID', got '$published_id'"
  fi
  if [[ "$pending_val" == "None" || -z "$pending_val" ]]; then
    pass_item "1.7e-pend" "pending = null after approval"
  else
    fail_item "1.7e-pend" "pending = null after approval" "Got pending = $pending_val"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.8 — Public stall endpoint
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_8a_public_approved_profile() {
  hr; echo "  1.8a: GET /stalls/:id/vendor-profile — approved profile visible"
  read_op "GET /stalls/${QA_STALL_ID}/vendor-profile?tenant_id=${QA_TENANT_ID}"
  curl_req GET "/stalls/${QA_STALL_ID}/vendor-profile?tenant_id=${QA_TENANT_ID}" ""
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.8a" "Public vendor profile endpoint" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    return
  fi
  local display_name industry
  display_name="$(json_get "$RESP_BODY" "d.get('profile', {}).get('display_name', '') if d.get('profile') else ''")"
  industry="$(json_get "$RESP_BODY" "d.get('profile', {}).get('industry', '') if d.get('profile') else ''")"
  local social_links_type
  social_links_type="$(printf '%s' "$RESP_BODY" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  print('array' if isinstance(d.get('social_links'), list) else 'not-array')
except Exception:
  print('not-array')
" 2>/dev/null || echo "not-array")"

  if [[ -n "$display_name" ]]; then
    pass_item "1.8a-name" "Public endpoint returns display_name ('$display_name')"
  else
    fail_item "1.8a-name" "Public endpoint display_name" "display_name is null/empty"
  fi
  if [[ -n "$industry" ]]; then
    pass_item "1.8a-ind" "Public endpoint returns industry (regression: was silently missing)"
  else
    fail_item "1.8a-ind" "Public endpoint industry field" \
      "industry is null/empty — regression: check vendor-profile-get route payload"
  fi
  if [[ "$social_links_type" == "array" ]]; then
    pass_item "1.8a-links" "Public endpoint social_links is array"
  else
    fail_item "1.8a-links" "Public endpoint social_links" "Expected array, got $social_links_type"
  fi
}

smoke_1_8b_public_no_tenant() {
  hr; echo "  1.8b: GET /stalls/:id/vendor-profile — missing tenant_id → 400"
  read_op "GET /stalls/${QA_STALL_ID}/vendor-profile (no tenant_id query param)"
  curl_req GET "/stalls/${QA_STALL_ID}/vendor-profile" ""
  if assert_http 400 "$RESP_STATUS"; then
    pass_item "1.8b" "Public endpoint without tenant_id → 400"
  else
    fail_item "1.8b" "Public endpoint missing tenant_id" "Expected 400, got $RESP_STATUS"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.7f — Reject-with-note (fresh draft cycle after approval)
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_7f_reject_with_note_cycle() {
  hr; echo "  1.7f: Reject-with-note flow (fresh draft cycle)"
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_item "1.7f" "Reject-with-note cycle" "dry-run"
    return
  fi

  write_op "PATCH to create new draft and submit it"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"display_name":"QA Reject Test","submit":true}'
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.7f" "Create + submit draft for reject test" "Expected 200, got $RESP_STATUS"
    return
  fi
  local reject_item_id state
  reject_item_id="$(json_get "$RESP_BODY" "d['item']['id']")"
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" != "submitted" ]]; then
    fail_item "1.7f" "Submit for reject test" "Expected submitted, got '$state'"
    return
  fi
  info "Second draft submitted (item: ${reject_item_id:0:8}…)"

  write_op "Claim second draft"
  curl_req POST "/moderation-items/${reject_item_id}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"under_review"}'
  if ! assert_http 200 "$RESP_STATUS"; then
    fail_item "1.7f" "Claim second draft for reject" "Expected 200, got $RESP_STATUS"
    return
  fi

  write_op "Reject with note → expect 200, state=rejected"
  curl_req POST "/moderation-items/${reject_item_id}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"rejected","note":"Smoke test: please update display name per brand guidelines"}'
  if assert_http 200 "$RESP_STATUS"; then
    local new_state
    new_state="$(json_get "$RESP_BODY" "d['item']['state']")"
    if [[ "$new_state" == "rejected" ]]; then
      pass_item "1.7f" "Reject-with-note → 200, state = rejected"
    else
      fail_item "1.7f" "Reject-with-note state" "Expected 'rejected', got '$new_state'"
    fi
  else
    fail_item "1.7f" "Reject-with-note" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1.4 — DB inspection (optional, requires DATABASE_URL)
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_4_db_moderation_notes() {
  hr; echo "  1.4: DB — moderation_notes rows have non-null new_status"
  if [[ -z "${DATABASE_URL:-}" ]]; then
    skip_item "1.4a" "DB: no null new_status in moderation_notes" \
      "DATABASE_URL not set — set to run psql assertions"
    skip_item "1.4b" "DB: submit note has new_status=submitted" \
      "DATABASE_URL not set"
    return
  fi
  read_op "psql: COUNT(*) WHERE new_status IS NULL"
  local null_count
  null_count="$(psql "$DATABASE_URL" -t -c \
    "SELECT COUNT(*) FROM moderation_notes WHERE new_status IS NULL;" 2>&1 | tr -d ' \n')"
  if [[ "$null_count" == "0" ]]; then
    pass_item "1.4a" "DB: 0 moderation_notes rows with null new_status"
  else
    fail_item "1.4a" "DB: null new_status rows" \
      "$null_count rows with null new_status — recordModerationTransition() missing call site"
  fi

  read_op "psql: most recent action=submit has new_status=submitted"
  local latest_status
  latest_status="$(psql "$DATABASE_URL" -t -c \
    "SELECT new_status FROM moderation_notes WHERE action='submit' ORDER BY created_at DESC LIMIT 1;" \
    2>&1 | tr -d ' \n')"
  if [[ "$latest_status" == "submitted" ]]; then
    pass_item "1.4b" "DB: most recent submit note has new_status='submitted'"
  else
    fail_item "1.4b" "DB: submit note new_status" "Expected 'submitted', got '$latest_status'"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# REPORT
# ─────────────────────────────────────────────────────────────────────────────

generate_report() {
  local total=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
  local run_time
  run_time="$(date '+%Y-%m-%d %H:%M:%S')"
  local mode
  mode="$(if [[ "$DRY_RUN" == "true" ]]; then echo "DRY-RUN"; else echo "LIVE"; fi)"

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  PHASE 1 BACKEND SMOKE — REPORT"
  echo "  Run at : $run_time"
  echo "  API    : $API_BASE_URL"
  echo "  Mode   : $mode"
  printf "  Total  : %d items\n" "$total"
  echo -e "  ${GREEN}Passed : $PASS_COUNT${RESET}"
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "  ${RED}Failed : $FAIL_COUNT${RESET}"
  else
    echo    "  Failed : $FAIL_COUNT"
  fi
  echo    "  Skipped: $SKIP_COUNT"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  printf "%-12s %-52s %-6s %s\n" "Item" "Description" "Result" "Notes"
  printf "%-12s %-52s %-6s %s\n" "------------" "----------------------------------------------------" "------" "--------"
  for row in "${REPORT_ROWS[@]}"; do
    IFS='|' read -r id desc result notes <<< "$row"
    local colour="$RESET"
    [[ "$result" == "PASS" ]] && colour="$GREEN"
    [[ "$result" == "FAIL" ]] && colour="$RED"
    [[ "$result" == "SKIP" ]] && colour="$YELLOW"
    printf "${colour}%-12s %-52s %-6s %s${RESET}\n" "$id" "${desc:0:52}" "$result" "${notes:0:70}"
  done
  echo ""

  # Build markdown content
  local md_content
  md_content="$(cat <<MDEOF
# Phase 1 Backend Smoke Report

**Run at:** $run_time
**API:** $API_BASE_URL
**Mode:** $mode

| Total | Passed | Failed | Skipped |
|---|---|---|---|
| $total | $PASS_COUNT | $FAIL_COUNT | $SKIP_COUNT |

| Item | Description | Result | Notes |
|---|---|---|---|
MDEOF
)"
  for row in "${REPORT_ROWS[@]}"; do
    IFS='|' read -r id desc result notes <<< "$row"
    local icon="✅"
    [[ "$result" == "FAIL" ]] && icon="❌"
    [[ "$result" == "SKIP" ]] && icon="⊘"
    md_content+=$'\n'"| $id | $desc | $icon $result | ${notes:-} |"
  done

  # Fan-out to three locations (§7)
  local tmp_report="/tmp/outputs/phase1_backend_smoke_report_${RUN_TS}.md"
  local repo_report="/Users/kishore/Codex_Development/docs/qa_reports/phase1_backend_smoke_report_${RUN_TS}.md"
  local vault_report="/Users/kishore/Documents/Obsidian_Claude/Codex Platform/qa_reports/phase1_backend_smoke_report_${RUN_TS}.md"
  mkdir -p /tmp/outputs
  mkdir -p "$(dirname "$repo_report")"
  mkdir -p "$(dirname "$vault_report")"
  printf '%s\n' "$md_content" | tee "$tmp_report" > "$repo_report"
  cp "$tmp_report" "$vault_report" 2>/dev/null || true

  echo "Report written to:"
  echo "  $tmp_report"
  echo "  $repo_report"
  echo "  $vault_report"
  echo ""

  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "${RED}${BOLD}RESULT: FAIL — $FAIL_COUNT item(s) failed${RESET}"
    echo "Each ❌ item becomes one entry in the phase fix-up commit."
    exit 1
  else
    echo -e "${GREEN}${BOLD}RESULT: ALL PASS ✅${RESET}"
    exit 0
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${BOLD}═══ Phase 1 Backend Smoke — Vendor Profile Core ═══${RESET}"
  echo "API: $API_BASE_URL"
  [[ "$DRY_RUN" == "true" ]] && echo -e "${YELLOW}DRY-RUN mode: no writes will be made${RESET}"
  echo ""

  # Reset pending state so re-runs start clean
  cleanup

  # Section A: Validation / negative tests (no state dependency)
  section "SECTION A — Validation / Negative Tests"
  smoke_A1_cross_org_isolation
  smoke_A2_invalid_logo_http
  smoke_A3_invalid_logo_javascript
  smoke_A4_description_length
  smoke_A4b_description_boundary
  smoke_A5_industry_too_long

  # Section B: Social links (independent of main draft flow)
  section "SECTION B — Social Links"
  smoke_1_5_get_social_links
  smoke_1_6_put_social_links_valid
  smoke_1_6c_invalid_channel
  smoke_1_6d_max_8_entries
  smoke_1_6e_https_only_url
  smoke_1_6f_javascript_url

  # Section C: Main happy path (draft → submit → claim → approve → public)
  section "SECTION C — Main Happy Path"
  smoke_1_1_get_profile_keys
  smoke_1_2_patch_save_draft
  smoke_1_3_patch_submit
  smoke_1_3_integrity                # item: save-draft on submitted → auto-withdraws to draft, re-submits
  smoke_1_7a_transition_claim        # item: submitted → under_review
  smoke_1_7b_self_approval_guard     # item stays under_review (403 expected)
  smoke_1_7c_reject_no_note          # item stays under_review (422 expected)
  smoke_1_7d_transition_approve      # item: under_review → approved
  smoke_1_7e_published_pointer       # verify vendor_profiles pointer swapped
  smoke_1_8a_public_approved_profile # public endpoint shows approved data
  smoke_1_8b_public_no_tenant        # missing tenant_id → 400
  smoke_1_7f_reject_with_note_cycle  # second draft: create → submit → claim → reject-with-note

  # Section D: DB assertions (optional)
  section "SECTION D — DB Assertions (requires DATABASE_URL)"
  smoke_1_4_db_moderation_notes

  generate_report
}

main "$@"
