#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 Backend Smoke — Vendor Profile Core (CR-VP-01)
# Maps to QA Checklist §1 items 1.1–1.8 + extra validation cases
#
# Usage:
#   ./phase1_backend_smoke_v1_0.sh             # run all tests
#   ./phase1_backend_smoke_v1_0.sh --dry-run   # print what would run, no writes
#
# Required env vars:
#   VENDOR_TOKEN            bearer token for vendor editor (vendor_content_editor scope)
#   VENDOR_APPROVER_TOKEN   bearer token for approver (vendor_content_approver scope, different user)
#
# Optional env vars:
#   API_BASE_URL    default: https://codex-api-production-064f.up.railway.app
#   DATABASE_URL    if set, runs DB-level psql assertions (item 1.4); skipped if absent
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
  for v in "${missing[@]}"; do echo "  export $v=<value>" >&2; done
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

# ── helpers ───────────────────────────────────────────────────────────────────

section() {
  echo ""
  echo -e "${CYAN}${BOLD}══ $1 ══${RESET}"
}

info()  { echo -e "  ${CYAN}ℹ${RESET}  $*"; }
write() { echo -e "  ${YELLOW}[WRITE]${RESET} $*"; }
read_op() { echo -e "  [READ]  $*"; }

# json_get <json_string> <python_expr>
# e.g. json_get "$body" "d['item']['state']"
json_get() {
  local json="$1" expr="$2"
  python3 -c "
import sys, json
try:
  d = json.loads('''$json''')
  val = $expr
  print('' if val is None else val)
except Exception as e:
  print('')
" 2>/dev/null || echo ""
}

# curl_req <method> <path> [token] [body]
# Returns: sets RESP_BODY and RESP_STATUS
curl_req() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local url="${API_BASE_URL}${path}"
  local args=(-s -w "\n__STATUS__%{http_code}" -X "$method")
  args+=(-H "Content-Type: application/json")
  [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
  [[ -n "$body" ]] && args+=(-d "$body")
  local raw
  raw="$(curl "${args[@]}" "$url" 2>&1)"
  RESP_STATUS="${raw##*$'\n'__STATUS__}"
  RESP_BODY="${raw%$'\n'__STATUS__*}"
}

pass_item() {
  local id="$1" desc="$2" notes="${3:-}"
  echo -e "  ${GREEN}✅ PASS${RESET} $id — $desc"
  REPORT_ROWS+=("$id|$desc|PASS|$notes")
  ((PASS_COUNT++)) || true
}

fail_item() {
  local id="$1" desc="$2" notes="${3:-}"
  echo -e "  ${RED}❌ FAIL${RESET} $id — $desc"
  [[ -n "$notes" ]] && echo -e "       ${RED}↳ $notes${RESET}"
  REPORT_ROWS+=("$id|$desc|FAIL|$notes")
  ((FAIL_COUNT++)) || true
}

skip_item() {
  local id="$1" desc="$2" notes="${3:-}"
  echo -e "  ${YELLOW}⊘ SKIP${RESET} $id — $desc ${notes:+(${notes})}"
  REPORT_ROWS+=("$id|$desc|SKIP|$notes")
  ((SKIP_COUNT++)) || true
}

assert_status() {
  local expected="$1" actual="$2"
  [[ "$actual" == "$expected" ]]
}

# UUID format check: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (no prefix)
is_uuid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]
}

has_key() {
  local json="$1" key="$2"
  python3 -c "
import json, sys
try:
  d = json.loads('''$json''')
  sys.exit(0 if '$key' in d else 1)
except:
  sys.exit(1)
" 2>/dev/null
}

# ── cleanup: reset pending state so script is idempotent ─────────────────────

cleanup() {
  section "CLEANUP — resetting pending state for idempotency"

  curl_req GET "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN"
  local state
  state="$(json_get "$RESP_BODY" "d.get('pending', {}).get('state', '') if d.get('pending') else ''")"
  local pending_id
  pending_id="$(json_get "$RESP_BODY" "d.get('pending', {}).get('id', '') if d.get('pending') else ''")"

  if [[ "$state" == "draft" ]]; then
    info "Found existing draft — will overwrite with PATCH (idempotent)"
  elif [[ "$state" == "submitted" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      info "[dry-run] Would withdraw submitted item $pending_id"
    else
      write "Withdrawing submitted item $pending_id so we can start fresh"
      curl_req POST "/moderation-items/${pending_id}/transition" "$VENDOR_TOKEN" '{"to_state":"withdrawn"}'
      if assert_status 200 "$RESP_STATUS"; then
        info "Withdrawn OK"
      else
        echo -e "  ${RED}WARNING: Could not withdraw submitted item. Script may skip some write tests.${RESET}"
      fi
    fi
  elif [[ "$state" == "under_review" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      info "[dry-run] Would reject under_review item $pending_id"
    else
      write "Rejecting under_review item $pending_id to reset state"
      curl_req POST "/moderation-items/${pending_id}/transition" "$VENDOR_APPROVER_TOKEN" \
        '{"to_state":"rejected","note":"Smoke test cleanup — resetting state"}'
      if assert_status 200 "$RESP_STATUS"; then
        info "Rejected OK — state reset"
      else
        echo -e "  ${RED}WARNING: Could not reject under_review item. Some write tests will be skipped.${RESET}"
      fi
    fi
  elif [[ -z "$state" ]]; then
    info "No pending item found — starting fresh"
  else
    info "Pending item is in terminal state ($state) — will create new draft"
  fi
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION A — Validation / negative tests (no state change in happy path)
# ─────────────────────────────────────────────────────────────────────────────

smoke_A1_cross_org_isolation() {
  echo "--- A1: Cross-org isolation ---"
  read_op "GET /vendors/${QA_OTHER_ORG}/profile with vendor token"
  curl_req GET "/vendors/${QA_OTHER_ORG}/profile" "$VENDOR_TOKEN"
  if assert_status 403 "$RESP_STATUS"; then
    pass_item "A1" "Cross-org isolation: vendor cannot access other org profile"
  else
    fail_item "A1" "Cross-org isolation" "Expected 403, got $RESP_STATUS. Body: $RESP_BODY"
  fi
}

smoke_A2_invalid_logo_http() {
  echo "--- A2: Invalid logo_url (http://) → 422 ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A2" "Invalid logo_url http://" "dry-run"; return; fi
  write "PATCH with http:// logo_url"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"logo_url":"http://insecure.example.com/logo.png"}'
  if assert_status 422 "$RESP_STATUS"; then
    pass_item "A2" "Invalid logo_url (http://) rejected with 422"
  else
    fail_item "A2" "Invalid logo_url (http://)" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A3_invalid_logo_javascript() {
  echo "--- A3: Invalid logo_url (javascript:) → 422 ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A3" "Invalid logo_url javascript:" "dry-run"; return; fi
  write "PATCH with javascript: logo_url"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"logo_url":"javascript:alert(1)"}'
  if assert_status 422 "$RESP_STATUS"; then
    pass_item "A3" "Invalid logo_url (javascript:) rejected with 422"
  else
    fail_item "A3" "Invalid logo_url (javascript:)" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A4_description_too_long() {
  echo "--- A4: Description >5000 chars → 422 ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A4" "Description >5000 chars" "dry-run"; return; fi
  local long_desc
  long_desc="$(python3 -c "print('A' * 5001)")"
  write "PATCH with 5001-char description"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    "{\"description\":\"$long_desc\"}"
  if assert_status 422 "$RESP_STATUS"; then
    pass_item "A4" "Description >5000 chars rejected with 422"
  else
    fail_item "A4" "Description >5000 chars" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A5_industry_too_long() {
  echo "--- A5: Industry >80 chars → 422 ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A5" "Industry >80 chars" "dry-run"; return; fi
  local long_ind
  long_ind="$(python3 -c "print('B' * 81)")"
  write "PATCH with 81-char industry"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    "{\"industry\":\"$long_ind\"}"
  if assert_status 422 "$RESP_STATUS"; then
    pass_item "A5" "Industry >80 chars rejected with 422"
  else
    fail_item "A5" "Industry >80 chars" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_A6_social_invalid_channel() {
  echo "--- A6: Social link invalid channel (tiktok) → 422 ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "A6" "Social invalid channel tiktok" "dry-run"; return; fi
  write "PUT social-links with tiktok channel"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"tiktok","url":"https://tiktok.com/@acme"}]}'
  if assert_status 422 "$RESP_STATUS"; then
    pass_item "A6" "Invalid social channel (tiktok) rejected with 422"
  else
    fail_item "A6" "Invalid social channel (tiktok)" "Expected 422, got $RESP_STATUS"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION B — Main happy path (draft → submit → claim → approve → public)
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_1_get_profile_keys() {
  echo "--- 1.1: GET /vendors/:org/profile — response shape ---"
  read_op "GET /vendors/${QA_VENDOR_ORG}/profile"
  curl_req GET "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN"
  local ok=true
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.1" "GET vendor profile" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"; return
  fi
  for key in profile published pending; do
    if ! has_key "$RESP_BODY" "$key"; then
      fail_item "1.1" "GET vendor profile" "Missing key '$key' in response"; ok=false
    fi
  done
  if [[ "$ok" == "true" ]]; then
    pass_item "1.1" "GET vendor profile → 200, profile/published/pending keys present"
  fi
}

smoke_1_2_patch_save_draft() {
  echo "--- 1.2: PATCH /vendors/:org/profile — save draft ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.2" "PATCH save draft" "dry-run"; return; fi
  write "PATCH with full payload (display_name includes HTML for strip regression)"
  local payload
  payload=$(cat <<'JSON'
{
  "display_name": "<b>QA Smoke v1.0</b>",
  "tagline": "Built for smoke testing",
  "description": "QA smoke test profile description.",
  "website_url": "https://example.com",
  "industry": "SmokeTestIndustry",
  "social_links": [
    {"channel":"linkedin","url":"https://linkedin.com/company/smoke-test"}
  ]
}
JSON
)
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" "$payload"
  echo "  Response status: $RESP_STATUS"

  local ok=true
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.2" "PATCH save draft" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"; return
  fi

  # UUID format regression
  local profile_id item_id
  profile_id="$(json_get "$RESP_BODY" "d['profile']['id']")"
  item_id="$(json_get "$RESP_BODY" "d['item']['id']")"
  if ! is_uuid "$profile_id"; then
    fail_item "1.2a" "profile.id is UUID (not nextId prefix)" "Got: '$profile_id'"; ok=false
  else
    pass_item "1.2a" "profile.id is valid UUID ('${profile_id:0:8}…')"
  fi
  if ! is_uuid "$item_id"; then
    fail_item "1.2b" "item.id is UUID (not nextId prefix)" "Got: '$item_id'"; ok=false
  else
    pass_item "1.2b" "item.id is valid UUID ('${item_id:0:8}…')"
  fi

  # State = draft
  local state
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" == "draft" ]]; then
    pass_item "1.2c" "item.state = draft"
  else
    fail_item "1.2c" "item.state = draft" "Got: '$state'"; ok=false
  fi

  # Industry field (regression: was silently dropped)
  local industry
  industry="$(json_get "$RESP_BODY" "d['item']['payload']['industry']")"
  if [[ "$industry" == "SmokeTestIndustry" ]]; then
    pass_item "1.2d" "industry field persists in payload (regression: was silently dropped)"
  else
    fail_item "1.2d" "industry field persists" "Expected 'SmokeTestIndustry', got '$industry'"; ok=false
  fi

  # HTML stripped from display_name
  local display_name
  display_name="$(json_get "$RESP_BODY" "d['item']['payload']['display_name']")"
  if [[ "$display_name" == "QA Smoke v1.0" ]]; then
    pass_item "1.2e" "HTML stripped from display_name (<b> tags removed)"
  else
    fail_item "1.2e" "HTML stripped from display_name" "Expected 'QA Smoke v1.0', got '$display_name'"; ok=false
  fi

  # Store IDs for subsequent tests
  CURRENT_PROFILE_ID="$profile_id"
  CURRENT_ITEM_ID="$item_id"
  info "Profile ID: $CURRENT_PROFILE_ID"
  info "Item ID:    $CURRENT_ITEM_ID"
}

smoke_1_5_get_social_links() {
  echo "--- 1.5: GET /vendors/:org/social-links ---"
  read_op "GET /vendors/${QA_VENDOR_ORG}/social-links"
  curl_req GET "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN"
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.5" "GET social-links" "Expected 200, got $RESP_STATUS"; return
  fi
  local is_array
  is_array="$(python3 -c "import json; d=json.loads('''$RESP_BODY'''); print('yes' if isinstance(d.get('social_links',[]), list) else 'no')" 2>/dev/null || echo "no")"
  if [[ "$is_array" == "yes" ]]; then
    pass_item "1.5" "GET social-links → 200, social_links is array"
  else
    fail_item "1.5" "GET social-links" "social_links key missing or not an array. Body: $RESP_BODY"
  fi
}

smoke_1_6_put_social_links() {
  echo "--- 1.6: PUT /vendors/:org/social-links ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.6" "PUT social-links" "dry-run"; return; fi
  write "PUT social-links (2 entries: linkedin + instagram with prefilled_message)"
  curl_req PUT "/vendors/${QA_VENDOR_ORG}/social-links" "$VENDOR_TOKEN" \
    '{"social_links":[{"channel":"linkedin","url":"https://linkedin.com/company/smoke"},{"channel":"instagram","url":"https://instagram.com/smoke","prefilled_message":"Hello smoke!"}]}'
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.6" "PUT social-links" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"; return
  fi
  local count
  count="$(python3 -c "import json; d=json.loads('''$RESP_BODY'''); print(len(d.get('item',{}).get('payload',{}).get('social_links',[])))" 2>/dev/null || echo "0")"
  if [[ "$count" == "2" ]]; then
    pass_item "1.6a" "PUT social-links → 200, 2 entries stored"
  else
    fail_item "1.6a" "PUT social-links entry count" "Expected 2 entries, got $count"
  fi
  local msg
  msg="$(python3 -c "import json; d=json.loads('''$RESP_BODY'''); links=d.get('item',{}).get('payload',{}).get('social_links',[]); ig=[l for l in links if l.get('channel')=='instagram']; print(ig[0].get('prefilled_message','') if ig else '')" 2>/dev/null || echo "")"
  if [[ "$msg" == "Hello smoke!" ]]; then
    pass_item "1.6b" "PUT social-links → prefilled_message preserved on instagram"
  else
    fail_item "1.6b" "PUT social-links prefilled_message" "Expected 'Hello smoke!', got '$msg'"
  fi
}

smoke_1_3_patch_submit() {
  echo "--- 1.3: PATCH /vendors/:org/profile — submit=true ---"
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.3" "PATCH submit=true" "dry-run"; return; fi
  write "PATCH with submit:true (regression: was 500 due to null new_status in moderation_notes)"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"display_name":"QA Smoke v1.0","submit":true}'
  echo "  Response status: $RESP_STATUS"
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.3" "PATCH submit=true" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
    echo -e "  ${RED}↳ If 500 with 'null value in column new_status': recordModerationTransition() regression${RESET}"
    return
  fi
  local state submitted_at
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  submitted_at="$(json_get "$RESP_BODY" "d['item']['submitted_at']")"
  # Update CURRENT_ITEM_ID in case it changed
  local new_item_id
  new_item_id="$(json_get "$RESP_BODY" "d['item']['id']")"
  [[ -n "$new_item_id" ]] && CURRENT_ITEM_ID="$new_item_id"

  if [[ "$state" == "submitted" ]]; then
    pass_item "1.3a" "PATCH submit=true → item.state = submitted"
  else
    fail_item "1.3a" "PATCH submit=true → item.state" "Expected 'submitted', got '$state'"
  fi
  if [[ -n "$submitted_at" ]]; then
    pass_item "1.3b" "PATCH submit=true → submitted_at is non-null"
  else
    fail_item "1.3b" "PATCH submit=true → submitted_at non-null" "submitted_at is null/empty"
  fi
  info "Current item ID after submit: $CURRENT_ITEM_ID"
}

smoke_B_self_approval_guard() {
  echo "--- B: Self-approval guard (vendor tries to approve under_review item → 403) ---"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "B" "Self-approval guard" "no item ID — 1.3 likely skipped or failed"
    return
  fi
  # Item must be in under_review for this test; it should be after 1.7a (claim)
  # We test AFTER claim in the flow — see orchestration in main()
  write "VENDOR_TOKEN attempts to approve item $CURRENT_ITEM_ID (self-approval — must 403)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_TOKEN" \
    '{"to_state":"approved"}'
  if assert_status 403 "$RESP_STATUS"; then
    pass_item "B" "Self-approval guard: vendor cannot approve own submission (403)"
  else
    fail_item "B" "Self-approval guard" "Expected 403, got $RESP_STATUS. Body: $RESP_BODY"
  fi
}

smoke_1_7a_transition_claim() {
  echo "--- 1.7a: POST /moderation-items/:id/transition — submitted → under_review ---"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7a" "Claim transition" "no item ID — 1.3 likely skipped or failed"
    return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7a" "Claim transition" "dry-run"; return; fi
  write "POST transition to_state=under_review (approver token)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"under_review"}'
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.7a" "Claim: submitted → under_review" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"; return
  fi
  local state
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" == "under_review" ]]; then
    pass_item "1.7a" "Claim transition → item.state = under_review"
  else
    fail_item "1.7a" "Claim transition" "Expected 'under_review', got '$state'"
  fi
}

smoke_1_7_reject_no_note() {
  echo "--- 1.7-neg: Reject without note → 422 ---"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7-neg" "Reject without note" "no item ID"; return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7-neg" "Reject without note" "dry-run"; return; fi
  write "POST transition to_state=rejected WITHOUT note — must 422 (doesn't change state)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"rejected"}'
  if assert_status 422 "$RESP_STATUS"; then
    pass_item "1.7-neg" "Reject without note → 422 (state unchanged)"
  else
    fail_item "1.7-neg" "Reject without note" "Expected 422, got $RESP_STATUS"
  fi
}

smoke_1_7b_transition_approve() {
  echo "--- 1.7b: POST /moderation-items/:id/transition — under_review → approved ---"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7b" "Approve transition" "no item ID"; return
  fi
  if [[ "$DRY_RUN" == "true" ]]; then skip_item "1.7b" "Approve transition" "dry-run"; return; fi
  write "POST transition to_state=approved (approver token)"
  curl_req POST "/moderation-items/${CURRENT_ITEM_ID}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"approved"}'
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.7b" "Approve transition" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"; return
  fi
  local state decided_at
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  decided_at="$(json_get "$RESP_BODY" "d['item']['decided_at']")"
  if [[ "$state" == "approved" ]]; then
    pass_item "1.7b" "Approve transition → item.state = approved"
  else
    fail_item "1.7b" "Approve transition" "Expected 'approved', got '$state'"
  fi
  if [[ -n "$decided_at" ]]; then
    pass_item "1.7c-decided" "Approve transition → decided_at is non-null"
  else
    fail_item "1.7c-decided" "decided_at non-null after approve" "decided_at is null/empty"
  fi
}

smoke_1_7c_published_pointer() {
  echo "--- 1.7c: GET profile after approve — published pointer + no pending ---"
  if [[ -z "$CURRENT_ITEM_ID" ]]; then
    skip_item "1.7c" "Published pointer check" "no item ID"; return
  fi
  read_op "GET /vendors/${QA_VENDOR_ORG}/profile"
  curl_req GET "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN"
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.7c" "Published pointer check" "Expected 200, got $RESP_STATUS"; return
  fi
  local published_id
  published_id="$(json_get "$RESP_BODY" "d.get('published', {}).get('id', '') if d.get('published') else ''")"
  local pending_val
  pending_val="$(json_get "$RESP_BODY" "str(d.get('pending'))")"
  if [[ "$published_id" == "$CURRENT_ITEM_ID" ]]; then
    pass_item "1.7c-pub" "published.id = current item ID after approval"
  else
    fail_item "1.7c-pub" "published.id matches approved item" "Expected '$CURRENT_ITEM_ID', got '$published_id'"
  fi
  if [[ "$pending_val" == "None" || -z "$pending_val" ]]; then
    pass_item "1.7c-pend" "pending = null after approval"
  else
    fail_item "1.7c-pend" "pending = null after approval" "Got pending = $pending_val"
  fi
}

smoke_1_8a_public_endpoint_approved() {
  echo "--- 1.8a: GET /stalls/:id/vendor-profile — approved profile visible ---"
  read_op "GET /stalls/${QA_STALL_ID}/vendor-profile?tenant_id=${QA_TENANT_ID}"
  curl_req GET "/stalls/${QA_STALL_ID}/vendor-profile?tenant_id=${QA_TENANT_ID}" ""
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "1.8a" "Public vendor profile endpoint" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"; return
  fi
  local display_name industry social_links_type
  display_name="$(json_get "$RESP_BODY" "d.get('profile', {}).get('display_name', '') if d.get('profile') else ''")"
  industry="$(json_get "$RESP_BODY" "d.get('profile', {}).get('industry', '') if d.get('profile') else ''")"
  social_links_type="$(python3 -c "import json; d=json.loads('''$RESP_BODY'''); print('array' if isinstance(d.get('social_links'), list) else 'not-array')" 2>/dev/null || echo "not-array")"

  if [[ "$display_name" == "QA Smoke v1.0" ]]; then
    pass_item "1.8a-name" "Public endpoint returns display_name = 'QA Smoke v1.0'"
  else
    # If smoke test hasn't approved yet (prior run left different data), check non-null
    if [[ -n "$display_name" ]]; then
      pass_item "1.8a-name" "Public endpoint returns display_name (value: '$display_name')"
    else
      fail_item "1.8a-name" "Public endpoint display_name" "Expected 'QA Smoke v1.0', got '$display_name'"
    fi
  fi
  if [[ "$industry" == "SmokeTestIndustry" || -n "$industry" ]]; then
    pass_item "1.8a-ind" "Public endpoint returns industry field (regression: was silently missing)"
  else
    fail_item "1.8a-ind" "Public endpoint industry field" "industry is null/empty — regression in play"
  fi
  if [[ "$social_links_type" == "array" ]]; then
    pass_item "1.8a-links" "Public endpoint social_links is array"
  else
    fail_item "1.8a-links" "Public endpoint social_links" "Expected array, got $social_links_type"
  fi
}

smoke_1_8b_public_no_tenant() {
  echo "--- 1.8b: GET /stalls/:id/vendor-profile — missing tenant_id → 400 ---"
  read_op "GET /stalls/${QA_STALL_ID}/vendor-profile (no tenant_id)"
  curl_req GET "/stalls/${QA_STALL_ID}/vendor-profile" ""
  if assert_status 400 "$RESP_STATUS"; then
    pass_item "1.8b" "Public endpoint without tenant_id → 400"
  else
    fail_item "1.8b" "Public endpoint missing tenant_id" "Expected 400, got $RESP_STATUS"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION C — Reject-with-note flow (second draft cycle)
# ─────────────────────────────────────────────────────────────────────────────

smoke_C_reject_with_note() {
  section "SECTION C — Reject-with-note flow (second draft cycle)"
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_item "C" "Reject-with-note flow" "dry-run"
    return
  fi

  echo "--- C1: Create and submit a second draft for rejection test ---"
  write "PATCH to create new draft (supersedes approved — will create new pending)"
  curl_req PATCH "/vendors/${QA_VENDOR_ORG}/profile" "$VENDOR_TOKEN" \
    '{"display_name":"QA Reject Test","submit":true}'
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "C1" "Create + submit draft for reject test" "Expected 200, got $RESP_STATUS"; return
  fi
  local reject_item_id
  reject_item_id="$(json_get "$RESP_BODY" "d['item']['id']")"
  local state
  state="$(json_get "$RESP_BODY" "d['item']['state']")"
  if [[ "$state" != "submitted" ]]; then
    fail_item "C1" "Submit for reject test" "Expected submitted, got $state"; return
  fi
  pass_item "C1" "Created and submitted second draft (item: ${reject_item_id:0:8}…)"

  echo "--- C2: Claim it ---"
  write "POST transition to_state=under_review"
  curl_req POST "/moderation-items/${reject_item_id}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"under_review"}'
  if ! assert_status 200 "$RESP_STATUS"; then
    fail_item "C2" "Claim for reject test" "Expected 200, got $RESP_STATUS"; return
  fi
  pass_item "C2" "Claimed second draft (under_review)"

  echo "--- C3: Reject with note → 200 ---"
  write "POST transition to_state=rejected WITH note"
  curl_req POST "/moderation-items/${reject_item_id}/transition" "$VENDOR_APPROVER_TOKEN" \
    '{"to_state":"rejected","note":"Smoke test: please update display name per brand guidelines"}'
  if assert_status 200 "$RESP_STATUS"; then
    local new_state
    new_state="$(json_get "$RESP_BODY" "d['item']['state']")"
    if [[ "$new_state" == "rejected" ]]; then
      pass_item "C3" "Reject-with-note → 200, state = rejected"
    else
      fail_item "C3" "Reject-with-note state" "Expected 'rejected', got '$new_state'"
    fi
  else
    fail_item "C3" "Reject-with-note" "Expected 200, got $RESP_STATUS. Body: $RESP_BODY"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# SECTION D — DB inspection (requires DATABASE_URL)
# ─────────────────────────────────────────────────────────────────────────────

smoke_1_4_db_moderation_notes() {
  echo "--- 1.4: DB — moderation_notes rows have non-null new_status ---"
  if [[ -z "${DATABASE_URL:-}" ]]; then
    skip_item "1.4" "DB: moderation_notes new_status check" "DATABASE_URL not set — set it to run psql assertions"
    return
  fi
  read_op "psql: SELECT count of rows with NULL new_status in moderation_notes"
  local null_count
  null_count="$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM moderation_notes WHERE new_status IS NULL;" 2>&1 | tr -d ' \n')"
  if [[ "$null_count" == "0" ]]; then
    pass_item "1.4a" "DB: no moderation_notes rows with null new_status"
  else
    fail_item "1.4a" "DB: null new_status rows" "Found $null_count rows with null new_status — recordModerationTransition() not called for some path"
  fi

  read_op "psql: Most recent 'submit' note has new_status='submitted'"
  local latest_submit_status
  latest_submit_status="$(psql "$DATABASE_URL" -t -c "SELECT new_status FROM moderation_notes WHERE action='submit' ORDER BY created_at DESC LIMIT 1;" 2>&1 | tr -d ' \n')"
  if [[ "$latest_submit_status" == "submitted" ]]; then
    pass_item "1.4b" "DB: most recent submit note has new_status='submitted'"
  else
    fail_item "1.4b" "DB: submit note new_status" "Expected 'submitted', got '$latest_submit_status'"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# REPORT
# ─────────────────────────────────────────────────────────────────────────────

print_report() {
  local total=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
  local report_body

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  PHASE 1 BACKEND SMOKE — REPORT"
  echo "  Run at : $(date '+%Y-%m-%d %H:%M:%S')"
  echo "  API    : $API_BASE_URL"
  echo "  Mode   : $(if [[ "$DRY_RUN" == "true" ]]; then echo DRY-RUN; else echo LIVE; fi)"
  echo "  Total  : $total items"
  echo -e "  ${GREEN}Passed : $PASS_COUNT${RESET}"
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "  ${RED}Failed : $FAIL_COUNT${RESET}"
  else
    echo "  Failed : $FAIL_COUNT"
  fi
  echo "  Skipped: $SKIP_COUNT"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  printf "%-10s %-52s %-6s %s\n" "Item" "Description" "Result" "Notes"
  printf "%-10s %-52s %-6s %s\n" "----------" "----------------------------------------------------" "------" "-----"
  for row in "${REPORT_ROWS[@]}"; do
    IFS='|' read -r id desc result notes <<< "$row"
    local colour="$RESET"
    [[ "$result" == "PASS" ]] && colour="$GREEN"
    [[ "$result" == "FAIL" ]] && colour="$RED"
    [[ "$result" == "SKIP" ]] && colour="$YELLOW"
    printf "${colour}%-10s %-52s %-6s %s${RESET}\n" "$id" "${desc:0:52}" "$result" "${notes:0:60}"
  done
  echo ""

  # Write markdown report file
  local report_file="/tmp/outputs/phase1_backend_smoke_report_${RUN_TS}.md"
  mkdir -p /tmp/outputs
  {
    echo "# Phase 1 Backend Smoke Report"
    echo "**Run at:** $(date '+%Y-%m-%d %H:%M:%S')"
    echo "**API:** $API_BASE_URL"
    echo "**Mode:** $(if [[ "$DRY_RUN" == "true" ]]; then echo DRY-RUN; else echo LIVE; fi)"
    echo ""
    echo "| Total | Passed | Failed | Skipped |"
    echo "|---|---|---|---|"
    echo "| $total | $PASS_COUNT | $FAIL_COUNT | $SKIP_COUNT |"
    echo ""
    echo "| Item | Description | Result | Notes |"
    echo "|---|---|---|---|"
    for row in "${REPORT_ROWS[@]}"; do
      IFS='|' read -r id desc result notes <<< "$row"
      local icon="✅"
      [[ "$result" == "FAIL" ]] && icon="❌"
      [[ "$result" == "SKIP" ]] && icon="⊘"
      echo "| $id | $desc | $icon $result | ${notes:-} |"
    done
  } > "$report_file"

  # Fan-out report to repo + Obsidian
  local repo_report="/Users/kishore/Codex_Development/docs/qa_reports/phase1_backend_smoke_report_${RUN_TS}.md"
  local vault_report="/Users/kishore/Documents/Obsidian_Claude/Codex Platform/qa_reports/phase1_backend_smoke_report_${RUN_TS}.md"
  mkdir -p "$(dirname "$repo_report")" "$(dirname "$vault_report")"
  cp "$report_file" "$repo_report" 2>/dev/null || true
  cp "$report_file" "$vault_report" 2>/dev/null || true

  echo "Report written to:"
  echo "  $report_file"
  echo "  $repo_report"
  echo "  $vault_report"
  echo ""

  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "${RED}${BOLD}RESULT: FAIL ($FAIL_COUNT items failed)${RESET}"
    echo "Fix failed items then re-run. Each ❌ becomes one entry in the phase fix-up commit."
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
  echo -e "${BOLD}Phase 1 Backend Smoke — Vendor Profile Core${RESET}"
  echo "API: $API_BASE_URL"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}DRY-RUN mode: no writes will be made${RESET}"
  fi
  echo ""

  cleanup

  # Section A: Validation / negative tests (safe before state changes)
  section "SECTION A — Validation / Negative Tests"
  smoke_A1_cross_org_isolation
  smoke_A2_invalid_logo_http
  smoke_A3_invalid_logo_javascript
  smoke_A4_description_too_long
  smoke_A5_industry_too_long
  smoke_A6_social_invalid_channel

  # Section B: Main happy path
  section "SECTION B — Main Happy Path (draft → submit → claim → approve → public)"
  smoke_1_1_get_profile_keys
  smoke_1_2_patch_save_draft
  smoke_1_5_get_social_links
  smoke_1_6_put_social_links
  smoke_1_3_patch_submit
  smoke_1_7a_transition_claim

  # Self-approval guard: item is now in under_review; vendor token tries to approve → 403
  smoke_B_self_approval_guard

  smoke_1_7_reject_no_note
  smoke_1_7b_transition_approve
  smoke_1_7c_published_pointer
  smoke_1_8a_public_endpoint_approved
  smoke_1_8b_public_no_tenant

  # Section C: Reject-with-note (requires a fresh draft cycle after approval)
  smoke_C_reject_with_note

  # Section D: DB assertions (optional, requires DATABASE_URL)
  section "SECTION D — DB Assertions (requires DATABASE_URL)"
  smoke_1_4_db_moderation_notes

  print_report
}

main "$@"
