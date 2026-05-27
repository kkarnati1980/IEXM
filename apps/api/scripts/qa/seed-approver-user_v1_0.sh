#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# seed-approver-user_v1_0.sh
# Creates vendor-approver@test.com via /users/invite + /auth/accept-invite,
# configures AP-4 flag separation (editor on vendor@test.com,
# approver on vendor-approver@test.com), writes both JWTs to
# /tmp/codex_qa_tokens.env for the smoke script to source.
#
# Idempotent: if approver already exists, re-logs in and refreshes tokens
# without re-creating.
#
# Usage:
#   bash seed-approver-user_v1_0.sh             # full run
#   bash seed-approver-user_v1_0.sh --dry-run   # skip writes, show what would happen
#
# Required env vars:
#   DATABASE_URL    Postgres connection string (for AP-4 flag SQL update)
#
# Optional env vars:
#   API_BASE_URL      (default: https://codex-api-production-064f.up.railway.app)
#   ADMIN_EMAIL       (default: admin@test.com)
#   ADMIN_PASSWORD    (default: TestPass123!)
#   VENDOR_EMAIL      (default: vendor@test.com)
#   VENDOR_PASSWORD   (default: TestPass123!)
#   APPROVER_EMAIL    (default: vendor-approver@test.com)
#   APPROVER_PASSWORD (default: TestPass123!)
#
# Exit codes:
#   0  all steps succeeded, tokens ready in /tmp/codex_qa_tokens.env
#   1  at least one step failed
#   2  environment variable missing or script error
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# ── flags ─────────────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

# ── env vars ──────────────────────────────────────────────────────────────────
API_BASE_URL="${API_BASE_URL:-https://codex-api-production-064f.up.railway.app}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@test.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-TestPass123!}"
VENDOR_EMAIL="${VENDOR_EMAIL:-vendor@test.com}"
VENDOR_PASSWORD="${VENDOR_PASSWORD:-TestPass123!}"
APPROVER_EMAIL="${APPROVER_EMAIL:-vendor-approver@test.com}"
APPROVER_PASSWORD="${APPROVER_PASSWORD:-TestPass123!}"

# DATABASE_URL is required (AP-4 flag SQL update needs direct DB access)
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required for AP-4 flag SQL update" >&2
  echo "  export DATABASE_URL=postgres://pilot@127.0.0.1:5432/pilot_platform" >&2
  echo "" >&2
  echo "  Use --dry-run to test the API steps without DATABASE_URL." >&2
  echo "  (Note: --dry-run still requires DATABASE_URL to be set.)" >&2
  exit 2
fi

# Verify psql is available
if ! command -v psql &>/dev/null; then
  echo "ERROR: psql not found in PATH — required for AP-4 flag SQL update" >&2
  exit 2
fi

# ── seed data constants (from store.mjs / test-fixtures.sh) ──────────────────
QA_ORG_ID="org-vendor"
QA_EVENT_ID="event-indiaexpo"
QA_STALL_ID="stall-ie-a1"

# ── report state ──────────────────────────────────────────────────────────────
declare -a REPORT_ROWS=()
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
RUN_TS="$(date '+%Y-%m-%d %H:%M:%S')"

# ── colour ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

# ── temp file for curl responses ──────────────────────────────────────────────
_CURL_TMP="$(mktemp)"
trap 'rm -f "$_CURL_TMP"' EXIT

# ── helpers ───────────────────────────────────────────────────────────────────

info()     { echo -e "  ${CYAN}ℹ${RESET}  $*"; }
write_op() { echo -e "  ${YELLOW}[WRITE]${RESET} $*"; }
read_op()  { echo -e "  [READ]  $*"; }

# json_get <json_string> <python_expr_using_d>
# Feeds JSON via stdin to avoid quoting issues with embedded special chars.
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

# curl_req <method> <path> [token] [body]
# Sets RESP_BODY (string) and RESP_STATUS (HTTP code).
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

pass_step() {
  local num="$1" desc="$2" notes="${3:-}"
  echo -e "  ${GREEN}✅ PASS${RESET} [Step $num] $desc${notes:+ — $notes}"
  REPORT_ROWS+=("$num|$desc|PASS|$notes")
  ((PASS_COUNT++)) || true
}

fail_step() {
  local num="$1" desc="$2" notes="${3:-}"
  echo -e "  ${RED}❌ FAIL${RESET} [Step $num] $desc"
  [[ -n "$notes" ]] && echo -e "       ${RED}↳ $notes${RESET}"
  REPORT_ROWS+=("$num|$desc|FAIL|$notes")
  ((FAIL_COUNT++)) || true
}

skip_step() {
  local num="$1" desc="$2" notes="${3:-}"
  echo -e "  ${YELLOW}⊘ SKIP${RESET} [Step $num] $desc${notes:+ ($notes)}"
  REPORT_ROWS+=("$num|$desc|SKIP|$notes")
  ((SKIP_COUNT++)) || true
}

# ── working state ──────────────────────────────────────────────────────────────
ADMIN_TOKEN=""
OUT_VENDOR_TOKEN=""
OUT_APPROVER_TOKEN=""
APPROVER_USER_ID=""
VENDOR_USER_ID=""
APPROVER_EXISTS=false

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1: Admin login
# ─────────────────────────────────────────────────────────────────────────────
step_1_admin_login() {
  echo ""
  echo "── Step 1: Admin login ──────────────────────────────────────────"
  read_op "POST /auth/login ($ADMIN_EMAIL)"
  curl_req POST "/auth/login" "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
  if [[ "$RESP_STATUS" != "200" ]]; then
    fail_step 1 "Admin login" "Expected 200, got $RESP_STATUS — check ADMIN_EMAIL / ADMIN_PASSWORD. Body: $RESP_BODY"
    return 1
  fi
  ADMIN_TOKEN="$(json_get "$RESP_BODY" "d['token']")"
  if [[ -z "$ADMIN_TOKEN" ]]; then
    fail_step 1 "Admin login" "200 received but token missing from response"
    return 1
  fi
  pass_step 1 "Admin login" "admin JWT captured"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2: Check whether approver user exists
# GET /users with role=vendor_manager filter; scan results for email match.
# (GET /users does not support email filtering; we filter client-side.)
# ─────────────────────────────────────────────────────────────────────────────
step_2_check_approver_exists() {
  echo ""
  echo "── Step 2: Check whether $APPROVER_EMAIL exists ─────────────────"
  read_op "GET /users?role=vendor_manager&page_size=100 (scan for $APPROVER_EMAIL)"
  curl_req GET "/users?role=vendor_manager&page_size=100" "$ADMIN_TOKEN"
  if [[ "$RESP_STATUS" != "200" ]]; then
    fail_step 2 "Check approver exists" "GET /users returned $RESP_STATUS — cannot determine user state"
    return 1
  fi
  local found_id
  found_id="$(printf '%s' "$RESP_BODY" | python3 -c "
import json, sys
try:
  d = json.load(sys.stdin)
  users = d.get('users', [])
  target = '$(printf '%s' "$APPROVER_EMAIL" | tr '[:upper:]' '[:lower:]')'
  match = [u for u in users if u.get('email','').lower() == target]
  print(match[0]['id'] if match else '')
except Exception:
  print('')
" 2>/dev/null || echo "")"

  if [[ -n "$found_id" ]]; then
    APPROVER_EXISTS=true
    APPROVER_USER_ID="$found_id"
    pass_step 2 "Check approver exists" "user exists (id=$found_id) — will login"
  else
    APPROVER_EXISTS=false
    pass_step 2 "Check approver exists" "user not found — will create via invite"
  fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3: Invite approver user (only if user does not yet exist)
# POST /users/invite → response includes raw invite_token (not the hash)
# vendor_manager requires: email, display_name, role, org_id, event_id, stall_ids
# ─────────────────────────────────────────────────────────────────────────────
step_3_invite_approver() {
  echo ""
  echo "── Step 3: Invite approver user ─────────────────────────────────"
  if [[ "$APPROVER_EXISTS" == "true" ]]; then
    skip_step 3 "Invite approver user" "user already exists"
    return 0
  fi
  if [[ "$DRY_RUN" == "true" ]]; then
    write_op "[dry-run] Would POST /users/invite for $APPROVER_EMAIL (role=vendor_manager, event=$QA_EVENT_ID)"
    skip_step 3 "Invite approver user" "dry-run"
    return 0
  fi

  write_op "POST /users/invite (email=$APPROVER_EMAIL, role=vendor_manager, event=$QA_EVENT_ID, stall=$QA_STALL_ID)"
  local body="{\"email\":\"$APPROVER_EMAIL\",\"display_name\":\"Vendor Approver\",\"role\":\"vendor_manager\",\"org_id\":\"$QA_ORG_ID\",\"event_id\":\"$QA_EVENT_ID\",\"stall_ids\":[\"$QA_STALL_ID\"]}"
  curl_req POST "/users/invite" "$ADMIN_TOKEN" "$body"
  if [[ "$RESP_STATUS" != "200" && "$RESP_STATUS" != "201" ]]; then
    fail_step 3 "Invite approver user" "Expected 200/201, got $RESP_STATUS — body: $RESP_BODY"
    return 1
  fi
  local raw_invite_token
  raw_invite_token="$(json_get "$RESP_BODY" "d['invite_token']")"
  APPROVER_USER_ID="$(json_get "$RESP_BODY" "d['user_id']")"
  if [[ -z "$raw_invite_token" ]]; then
    fail_step 3 "Invite approver user" "invite_token missing from response — endpoint does not return raw token; cannot proceed"
    return 1
  fi
  pass_step 3 "Invite approver user" "user_id=$APPROVER_USER_ID; invite_token captured"
  # Store token for step 4
  _INVITE_TOKEN="$raw_invite_token"
  return 0
}

_INVITE_TOKEN=""

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4: Accept invite (new user) OR login (existing user) → approver JWT
# ─────────────────────────────────────────────────────────────────────────────
step_4_get_approver_token() {
  echo ""
  echo "── Step 4: Acquire approver JWT ─────────────────────────────────"
  if [[ "$APPROVER_EXISTS" == "false" ]]; then
    # New user path: accept invite
    if [[ "$DRY_RUN" == "true" ]]; then
      write_op "[dry-run] Would POST /auth/accept-invite to activate $APPROVER_EMAIL"
      skip_step 4 "Accept invite / set password" "dry-run"
      return 0
    fi
    if [[ -z "$_INVITE_TOKEN" ]]; then
      fail_step 4 "Accept invite / set password" "invite token not captured (Step 3 may have failed)"
      return 1
    fi
    write_op "POST /auth/accept-invite (token=<raw_invite_token>, password=***)"
    curl_req POST "/auth/accept-invite" "" "{\"token\":\"$_INVITE_TOKEN\",\"password\":\"$APPROVER_PASSWORD\"}"
    if [[ "$RESP_STATUS" != "200" ]]; then
      fail_step 4 "Accept invite / set password" "Expected 200, got $RESP_STATUS — body: $RESP_BODY"
      return 1
    fi
    OUT_APPROVER_TOKEN="$(json_get "$RESP_BODY" "d['token']")"
    if [[ -z "$OUT_APPROVER_TOKEN" ]]; then
      fail_step 4 "Accept invite / set password" "token missing from accept-invite response"
      return 1
    fi
    pass_step 4 "Accept invite / set password" "approver JWT captured (account activated)"
  else
    # Existing user path: login directly
    read_op "POST /auth/login ($APPROVER_EMAIL)"
    curl_req POST "/auth/login" "" "{\"email\":\"$APPROVER_EMAIL\",\"password\":\"$APPROVER_PASSWORD\"}"
    if [[ "$RESP_STATUS" != "200" ]]; then
      fail_step 4 "Login as existing approver" \
        "Expected 200, got $RESP_STATUS — user exists but password may not match APPROVER_PASSWORD. Manual intervention needed."
      return 1
    fi
    OUT_APPROVER_TOKEN="$(json_get "$RESP_BODY" "d['token']")"
    if [[ -z "$OUT_APPROVER_TOKEN" ]]; then
      fail_step 4 "Login as existing approver" "token missing from login response"
      return 1
    fi
    pass_step 4 "Login as existing approver" "approver JWT captured"
  fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5: Configure AP-4 flag separation via SQL
# vendor@test.com      → vendor_content_editor=true,  vendor_content_approver=false
# vendor-approver@test.com → vendor_content_editor=false, vendor_content_approver=true
# ─────────────────────────────────────────────────────────────────────────────
step_5_configure_ap4_flags() {
  echo ""
  echo "── Step 5: Configure AP-4 flag separation ───────────────────────"
  if [[ "$DRY_RUN" == "true" ]]; then
    write_op "[dry-run] Would UPDATE users SET:"
    echo "    $VENDOR_EMAIL      → vendor_content_editor=TRUE,  vendor_content_approver=FALSE"
    echo "    $APPROVER_EMAIL → vendor_content_editor=FALSE, vendor_content_approver=TRUE"
    skip_step 5 "Configure AP-4 flags" "dry-run"
    return 0
  fi

  write_op "UPDATE users: AP-4 flag separation on 2 users"
  local r1 r2
  r1="$(psql "$DATABASE_URL" -c "UPDATE users SET vendor_content_editor = TRUE, vendor_content_approver = FALSE WHERE email = '${VENDOR_EMAIL}';" 2>&1)"
  local e1=$?
  r2="$(psql "$DATABASE_URL" -c "UPDATE users SET vendor_content_editor = FALSE, vendor_content_approver = TRUE  WHERE email = '${APPROVER_EMAIL}';" 2>&1)"
  local e2=$?
  if [[ $e1 -ne 0 || $e2 -ne 0 ]]; then
    fail_step 5 "Configure AP-4 flags" "psql error — vendor: '$r1' (exit $e1) approver: '$r2' (exit $e2)"
    return 1
  fi
  info "vendor: $r1"
  info "approver: $r2"
  pass_step 5 "Configure AP-4 flags" "SQL UPDATE 2 rows"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6: Verify AP-4 flag final state
# ─────────────────────────────────────────────────────────────────────────────
step_6_verify_flags() {
  echo ""
  echo "── Step 6: Verify AP-4 flag state ──────────────────────────────"
  if [[ "$DRY_RUN" == "true" ]]; then
    skip_step 6 "Verify final state" "dry-run"
    return 0
  fi

  read_op "SELECT email, vendor_content_editor, vendor_content_approver FROM users WHERE email IN ('...')"
  local verify_sql="SELECT email, vendor_content_editor, vendor_content_approver FROM users WHERE email IN ('${VENDOR_EMAIL}','${APPROVER_EMAIL}') ORDER BY email;"
  local verify_out
  verify_out="$(psql "$DATABASE_URL" -c "$verify_sql" 2>&1)"
  local psql_exit=$?
  if [[ $psql_exit -ne 0 ]]; then
    fail_step 6 "Verify final state" "psql error: $verify_out"
    return 1
  fi
  echo ""
  echo "$verify_out"
  echo ""

  # Check individual values
  local vendor_editor vendor_approver_col approver_editor approver_approver_col
  vendor_editor="$(psql "$DATABASE_URL" -t -c "SELECT vendor_content_editor  FROM users WHERE email='${VENDOR_EMAIL}';"   2>/dev/null | tr -d ' \n')"
  vendor_approver_col="$(psql "$DATABASE_URL" -t -c "SELECT vendor_content_approver FROM users WHERE email='${VENDOR_EMAIL}';"   2>/dev/null | tr -d ' \n')"
  approver_editor="$(psql "$DATABASE_URL" -t -c "SELECT vendor_content_editor  FROM users WHERE email='${APPROVER_EMAIL}';" 2>/dev/null | tr -d ' \n')"
  approver_approver_col="$(psql "$DATABASE_URL" -t -c "SELECT vendor_content_approver FROM users WHERE email='${APPROVER_EMAIL}';" 2>/dev/null | tr -d ' \n')"

  local ok=true
  if [[ "$vendor_editor" != "t" ]]; then
    echo -e "  ${RED}↳ $VENDOR_EMAIL vendor_content_editor should be t, got '$vendor_editor'${RESET}"
    ok=false
  fi
  if [[ "$vendor_approver_col" != "f" ]]; then
    echo -e "  ${RED}↳ $VENDOR_EMAIL vendor_content_approver should be f, got '$vendor_approver_col'${RESET}"
    ok=false
  fi
  if [[ "$approver_editor" != "f" ]]; then
    echo -e "  ${RED}↳ $APPROVER_EMAIL vendor_content_editor should be f, got '$approver_editor'${RESET}"
    ok=false
  fi
  if [[ "$approver_approver_col" != "t" ]]; then
    echo -e "  ${RED}↳ $APPROVER_EMAIL vendor_content_approver should be t, got '$approver_approver_col'${RESET}"
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    pass_step 6 "Verify final state" "both flags correctly separated"
  else
    fail_step 6 "Verify final state" "one or more flags not as expected"
    return 1
  fi
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7: Capture vendor token (login as vendor@test.com)
# ─────────────────────────────────────────────────────────────────────────────
step_7_capture_vendor_token() {
  echo ""
  echo "── Step 7: Capture vendor token ─────────────────────────────────"
  read_op "POST /auth/login ($VENDOR_EMAIL)"
  curl_req POST "/auth/login" "" "{\"email\":\"$VENDOR_EMAIL\",\"password\":\"$VENDOR_PASSWORD\"}"
  if [[ "$RESP_STATUS" != "200" ]]; then
    fail_step 7 "Capture vendor token" "Expected 200, got $RESP_STATUS — check VENDOR_EMAIL / VENDOR_PASSWORD"
    return 1
  fi
  OUT_VENDOR_TOKEN="$(json_get "$RESP_BODY" "d['token']")"
  VENDOR_USER_ID="$(json_get "$RESP_BODY" "d['user']['id']")"
  if [[ -z "$OUT_VENDOR_TOKEN" ]]; then
    fail_step 7 "Capture vendor token" "token missing from vendor login response"
    return 1
  fi
  pass_step 7 "Capture vendor token" "vendor JWT captured (user_id=$VENDOR_USER_ID)"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8: Write sourceable env file
# ─────────────────────────────────────────────────────────────────────────────
step_8_write_env_file() {
  echo ""
  echo "── Step 8: Write token env file ─────────────────────────────────"
  local env_file="/tmp/codex_qa_tokens.env"

  if [[ "$DRY_RUN" == "true" ]]; then
    write_op "[dry-run] Would write $env_file (tokens not available in dry-run)"
    skip_step 8 "Write env file" "dry-run"
    return 0
  fi

  if [[ -z "$OUT_VENDOR_TOKEN" || -z "$OUT_APPROVER_TOKEN" ]]; then
    fail_step 8 "Write env file" "One or both tokens empty — cannot write env file"
    return 1
  fi

  cat > "$env_file" <<ENVEOF
# Generated by seed-approver-user_v1_0.sh
# Run at: ${RUN_TS}
# API:    ${API_BASE_URL}
# VENDOR_TOKEN          → ${VENDOR_EMAIL} (id=${VENDOR_USER_ID:-unknown})
# VENDOR_APPROVER_TOKEN → ${APPROVER_EMAIL} (id=${APPROVER_USER_ID:-unknown})
export VENDOR_TOKEN="${OUT_VENDOR_TOKEN}"
export VENDOR_APPROVER_TOKEN="${OUT_APPROVER_TOKEN}"
ENVEOF

  pass_step 8 "Write env file" "$env_file"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# REPORT
# ─────────────────────────────────────────────────────────────────────────────
generate_report() {
  local mode
  mode="$(if [[ "$DRY_RUN" == "true" ]]; then echo "DRY-RUN"; else echo "LIVE"; fi)"
  local total=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))

  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  USER SEED — REPORT"
  echo "  Run at : $RUN_TS"
  echo "  API    : $API_BASE_URL"
  echo "  Mode   : $mode"
  printf "  Total  : %d steps\n" "$total"
  echo -e "  ${GREEN}Passed : $PASS_COUNT${RESET}"
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "  ${RED}Failed : $FAIL_COUNT${RESET}"
  else
    echo    "  Failed : $FAIL_COUNT"
  fi
  echo    "  Skipped: $SKIP_COUNT"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  printf "%-6s %-40s %-6s %s\n" "Step" "Description" "Result" "Notes"
  printf "%-6s %-40s %-6s %s\n" "------" "----------------------------------------" "------" "--------"
  for row in "${REPORT_ROWS[@]}"; do
    IFS='|' read -r num desc result notes <<< "$row"
    local colour="$RESET"
    [[ "$result" == "PASS" ]] && colour="$GREEN"
    [[ "$result" == "FAIL" ]] && colour="$RED"
    [[ "$result" == "SKIP" ]] && colour="$YELLOW"
    printf "${colour}%-6s %-40s %-6s %s${RESET}\n" "$num" "${desc:0:40}" "$result" "${notes:0:60}"
  done
  echo ""

  if [[ "$DRY_RUN" != "true" && $FAIL_COUNT -eq 0 ]]; then
    echo "  TOKEN FILE: /tmp/codex_qa_tokens.env"
    echo "  Source it before running the smoke script:"
    echo ""
    echo "    source /tmp/codex_qa_tokens.env"
    echo "    bash apps/api/scripts/qa/phase1_backend_smoke_v1_0.sh"
    echo ""
  fi

  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "${RED}${BOLD}RESULT: FAIL — $FAIL_COUNT step(s) failed${RESET}"
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
  echo -e "${BOLD}═══ User Seed — vendor-approver@test.com + AP-4 flags ═══${RESET}"
  echo "API: $API_BASE_URL"
  [[ "$DRY_RUN" == "true" ]] && echo -e "${YELLOW}DRY-RUN mode: writes (invite, accept-invite, SQL UPDATE) are skipped${RESET}"
  echo ""

  step_1_admin_login        || { generate_report; }
  step_2_check_approver_exists || { generate_report; }
  step_3_invite_approver    || { generate_report; }
  step_4_get_approver_token || { generate_report; }
  step_5_configure_ap4_flags || { generate_report; }
  step_6_verify_flags       || { generate_report; }
  step_7_capture_vendor_token || { generate_report; }
  step_8_write_env_file     || { generate_report; }

  generate_report
}

main "$@"
