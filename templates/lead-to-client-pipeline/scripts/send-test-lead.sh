#!/usr/bin/env bash
# Post one signed test lead to WF-A. For manual Phase-0 verification only.
#
# Usage:
#   export LEAD_HMAC_SECRET='...'          # the value in the n8n 'Crypto account' credential
#   scripts/send-test-lead.sh <webhook-base> [urgent|normal]
#
# Signature: sha256_hex("<ref>.<submittedAt>.<email>"), matching
# wf-a-lead-intake.json's `Validate & Normalise` node exactly. The secret is
# read from the environment only -- never written to a file, never logged,
# never passed as a CLI arg (which would leak into shell history / `ps`).
set -euo pipefail

[ -n "${LEAD_HMAC_SECRET:-}" ] || { echo "set LEAD_HMAC_SECRET first (export, don't pass as an arg)" >&2; exit 2; }
BASE="${1:?usage: $0 <webhook-base-url> [urgent|normal]}"
MODE="${2:-normal}"

REF="test-$(date +%s)-$$"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EMAIL="lead-pipeline-test+${REF}@prudentiadigital.co.za"

case "$MODE" in
  urgent) TIMELINE="asap"; BUDGET="150k-plus" ;;
  normal) TIMELINE="exploring"; BUDGET="lt-25k" ;;
  *) echo "mode must be 'urgent' or 'normal'" >&2; exit 2 ;;
esac

SIG=$(printf '%s.%s.%s' "$REF" "$TS" "$EMAIL" \
      | openssl dgst -sha256 -hmac "$LEAD_HMAC_SECRET" -hex \
      | sed 's/^.* //')

BODY=$(cat <<JSON
{
  "name": "Lead Pipeline Test",
  "email": "$EMAIL",
  "service": "automation",
  "timeline": "$TIMELINE",
  "budget": "$BUDGET",
  "submissionId": "$REF",
  "submittedAt": "$TS",
  "signature": "$SIG",
  "source": "manual-verification"
}
JSON
)

echo "POST ${BASE%/}/webhook-test/lead-intake  (mode=$MODE, ref=$REF)"
curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST "${BASE%/}/webhook-test/lead-intake" \
  -H 'Content-Type: application/json' \
  -d "$BODY"

echo
echo "Test email address (search the leads table / GoDaddy Sent folder): $EMAIL"
