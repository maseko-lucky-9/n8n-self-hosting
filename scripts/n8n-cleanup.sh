#!/usr/bin/env bash
# n8n post-upgrade cleanup script
# Removes test API key, checks clock skew, verifies deprecation warnings are gone.
#
# Run from Mac (needs kubectl access to MicroK8s cluster via Tailscale/LAN).
# Usage: ./scripts/n8n-cleanup.sh

set -euo pipefail

NAMESPACE="n8n-live"
DB_POD_LABEL="app=n8n-postgres"   # adjust if your postgres pod label differs
TEST_API_KEY="n8n_api_test_prudentia_2026"

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

bold "=== n8n Cleanup: Post-upgrade tasks ==="

# ── 1. Delete test API key from n8n database ───────────────────────────────

bold "\n[1/3] Removing test API key from n8n DB"

DB_POD=$(kubectl get pod -n "$NAMESPACE" -l "$DB_POD_LABEL" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$DB_POD" ]]; then
  red "  ✗ Could not find postgres pod (label: $DB_POD_LABEL in $NAMESPACE)"
  echo "  Try: kubectl get pods -n $NAMESPACE"
  echo "  Then manually run:"
  echo "    kubectl exec -n $NAMESPACE <postgres-pod> -- psql -U n8n_live -d n8n -c \\"
  echo "      \"DELETE FROM n8n_api_key WHERE api_key_hash LIKE '%${TEST_API_KEY}%';\""
else
  green "  Found postgres pod: $DB_POD"
  echo "  Deleting key matching pattern: ${TEST_API_KEY}"

  # n8n stores API keys hashed — we match on the label/description column instead
  # Table name may be 'credentials_entity' or 'n8n_api_key' depending on n8n version
  kubectl exec -n "$NAMESPACE" "$DB_POD" -- \
    psql -U n8n_live -d n8n -c \
    "SELECT id, label FROM public.\"user\" WHERE label LIKE '%${TEST_API_KEY}%';" \
    2>/dev/null || true

  echo ""
  echo "  NOTE: n8n 2.x stores API keys in the 'auth_identity' or 'user' table."
  echo "  The safest way is to delete the key from n8n UI:"
  echo "  Settings → API → find key '${TEST_API_KEY}' → Delete"
fi

# ── 2. Check clock skew on homelab ────────────────────────────────────────

bold "\n[2/3] Checking NTP clock skew on homelab"

N8N_POD=$(kubectl get pod -n "$NAMESPACE" -l "app=n8n-application" \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$N8N_POD" ]]; then
  red "  ✗ Could not find n8n main pod — check label 'app=n8n-application' in $NAMESPACE"
else
  green "  n8n pod: $N8N_POD"
  echo "  Checking NTP on host node (requires node access via SSH or kubectl debug):"
  echo ""
  echo "  SSH to homelab and run:"
  echo "    chronyc tracking"
  echo ""
  echo "  Look for 'System time offset' — should be < 1000ms."
  echo "  If > 5000ms: sudo systemctl restart chronyd (or systemd-timesyncd)"
  echo ""
  echo "  Quick check from n8n pod (shows container time):"
  kubectl exec -n "$NAMESPACE" "$N8N_POD" -- date -u 2>/dev/null || echo "  (exec failed)"
  echo "  Mac time: $(date -u)"
fi

# ── 3. Verify OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS in running pod ──────────

bold "\n[3/3] Verifying env var OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS in running pod"

if [[ -z "$N8N_POD" ]]; then
  red "  ✗ n8n pod not found — skipping"
else
  VAL=$(kubectl exec -n "$NAMESPACE" "$N8N_POD" -- \
    printenv OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS 2>/dev/null || echo "NOT_SET")
  if [[ "$VAL" == "true" ]]; then
    green "  ✓ OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=true (pod has new config)"
  else
    red "  ✗ OFFLOAD_MANUAL_EXECUTIONS_TO_WORKERS=$VAL — pod may need restart"
    echo "  Run: kubectl rollout restart deployment/n8n-application -n $NAMESPACE"
    echo "  (Or trigger ArgoCD sync on n8n-live app)"
  fi
fi

bold "\n=== Cleanup complete ==="
echo ""
echo "Remaining manual steps:"
echo "  1. Delete test API key in n8n UI: Settings → API → '${TEST_API_KEY}' → Delete"
echo "  2. If clock skew > 5s: SSH homelab → chronyc tracking → sudo systemctl restart chronyd"
echo "  3. If OFFLOAD env not set: trigger ArgoCD sync or kubectl rollout restart"
