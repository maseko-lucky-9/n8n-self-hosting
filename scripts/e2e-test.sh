#!/usr/bin/env bash
# E2E test script — Prudentia SME Professional Services demo workflows
# Run from Mac (LAN or Tailscale). Requires curl and jq.
#
# Usage:
#   ./scripts/e2e-test.sh              # run all tests
#   ./scripts/e2e-test.sh w1           # run only W1
#   ./scripts/e2e-test.sh w3           # run only W3
#
# Prerequisites:
#   - n8n reachable at N8N_URL
#   - W1 and W3 are Published (active) in n8n UI
#   - SMTP credential assigned to all email nodes
#   - W1: Google Sheets credential assigned + SHEET_ID set in workflow
#   - W2: trigger manually in n8n UI (see instructions below)

set -euo pipefail

N8N_URL="${N8N_URL:-https://n8n.homelab.local}"
TEST_EMAIL="${TEST_EMAIL:-ltmaseko7@gmail.com}"
PASS=0
FAIL=0

# ── Helpers ────────────────────────────────────────────────────────────────

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

assert_json_field() {
  local label="$1" response="$2" field="$3" expected="$4"
  local actual
  actual=$(echo "$response" | jq -r "$field" 2>/dev/null || echo "PARSE_ERROR")
  if [[ "$actual" == "$expected" ]]; then
    green "  ✓ $label: $actual"
    PASS=$((PASS+1))
  else
    red "  ✗ $label: expected '$expected', got '$actual'"
    FAIL=$((FAIL+1))
  fi
}

assert_http_200() {
  local label="$1" status="$2"
  if [[ "$status" == "200" ]]; then
    green "  ✓ $label: HTTP 200"
    PASS=$((PASS+1))
  else
    red "  ✗ $label: expected HTTP 200, got $status"
    FAIL=$((FAIL+1))
  fi
}

post_webhook() {
  local path="$1" payload="$2"
  curl -sk -o /tmp/n8n_response.json -w "%{http_code}" \
    -X POST "${N8N_URL}/webhook/${path}" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

# ── W1 — Client Intake & Onboarding ────────────────────────────────────────

test_w1() {
  bold "\n[W1] Client Intake & Onboarding"
  echo "  Endpoint: ${N8N_URL}/webhook/prudentia-client-intake"
  echo "  Email:    ${TEST_EMAIL}"

  local payload
  payload=$(cat <<EOF
{
  "client_name": "Nomvula Dlamini",
  "email": "${TEST_EMAIL}",
  "service": "Monthly Bookkeeping",
  "phone": "+27 82 000 0001",
  "notes": "E2E test — $(date '+%Y-%m-%d %H:%M')",
  "docs_received": false
}
EOF
)

  local status
  status=$(post_webhook "prudentia-client-intake" "$payload")
  local response
  response=$(cat /tmp/n8n_response.json)

  assert_http_200 "HTTP status" "$status"
  # Webhook runs in onReceived mode — responds immediately with workflow-started message
  # (SMTP blocked on port 587/465; email sends async via worker after response goes out)
  assert_json_field "response.message" "$response" '.message' "Workflow was started"

  echo ""
  echo "  Manual checks required:"
  echo "  → Welcome email received at ${TEST_EMAIL} (subject: 'Welcome to Prudentia Digital')"
  echo "    NOTE: SMTP blocked from pod network — email will fail until Brevo/port fix applied"
  echo "  → Google Sheet has new row: client_name=Nomvula Dlamini, docs_received=FALSE"
  echo "    NOTE: Sheets requires SHEET_ID_PLACEHOLDER replaced in n8n UI"
  echo "  → Raw response: $(echo "$response" | jq -c '.')"
}

# ── W2 — Document Chase ─────────────────────────────────────────────────────

test_w2_instructions() {
  bold "\n[W2] Document Chase (POPIA-Aware) — Manual Trigger Required"
  echo ""
  echo "  W2 is a scheduled workflow. To test it now:"
  echo "  1. Open https://n8n.homelab.local in browser"
  echo "  2. Open 'Prudentia | W2 - Document Chase (POPIA-Aware)'"
  echo "  3. Click ▶ 'Test workflow' (top right)"
  echo "  4. Verify in Executions tab: status = Success"
  echo ""
  echo "  Expected output:"
  echo "  → Chase email sent to: demo+nomvula@prudentiadigital.co.za (5 days overdue)"
  echo "  → Chase email sent to: demo+sipho@prudentiadigital.co.za  (8 days overdue, last reminder 3 days ago)"
  echo "  → Lungelo skipped (docs_received=true)"
  echo ""
  echo "  Note: demo+nomvula and demo+sipho route to your Gmail inbox via + addressing."
  echo "  Check for 2 chase emails with subject: 'Friendly Reminder — Documents Outstanding'"
}

# ── W3 — Quote Dispatch ─────────────────────────────────────────────────────

test_w3() {
  bold "\n[W3] Quote Dispatch"
  echo "  Endpoint: ${N8N_URL}/webhook/prudentia-quote"
  echo "  Email:    ${TEST_EMAIL}"

  local payload
  payload=$(cat <<EOF
{
  "client_name": "Sipho Attorneys Inc.",
  "email": "${TEST_EMAIL}",
  "service": "Monthly Workflow Automation Retainer",
  "amount": "R12,500"
}
EOF
)

  local status
  status=$(post_webhook "prudentia-quote" "$payload")
  local response
  response=$(cat /tmp/n8n_response.json)

  assert_http_200 "HTTP status" "$status"
  # Webhook runs in onReceived mode — responds immediately
  assert_json_field "response.message" "$response" '.message' "Workflow was started"

  echo ""
  echo "  Manual checks required:"
  echo "  → Quote email received at ${TEST_EMAIL} (subject: 'Your Quotation from Prudentia Digital')"
  echo "    NOTE: SMTP blocked from pod network — email will fail until Brevo/port fix applied"
  echo "  → Consultant alert received (to: thulani@prudentiadigital.co.za, subject: '[ACTION] Quote sent')"
}

# ── Summary ─────────────────────────────────────────────────────────────────

print_summary() {
  bold "\n──────────────────────────────────────────"
  bold "E2E Test Summary"
  bold "──────────────────────────────────────────"
  green "  Automated assertions passed: ${PASS}"
  if [[ $FAIL -gt 0 ]]; then
    red "  Automated assertions failed: ${FAIL}"
  else
    green "  Automated assertions failed: ${FAIL}"
  fi
  echo ""
  echo "  Manual checks (emails + Sheets) require human verification."
  bold "──────────────────────────────────────────"
}

# ── Entry point ─────────────────────────────────────────────────────────────

FILTER="${1:-all}"

case "$FILTER" in
  w1) test_w1 ;;
  w2) test_w2_instructions ;;
  w3) test_w3 ;;
  all)
    test_w1
    test_w2_instructions
    test_w3
    ;;
  *)
    echo "Usage: $0 [w1|w2|w3|all]"
    exit 1
    ;;
esac

print_summary
