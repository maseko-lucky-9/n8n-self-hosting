#!/bin/bash
# Validation test suite for environment refactor
set -uo pipefail

CHART="helm/n8n-application"
PASS=0
FAIL=0

log_pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
log_fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

for RUN in 1 2 3; do
  echo "========================================"
  echo "RUN $RUN/3"
  echo "========================================"

  # Test 1: Helm lint local
  if helm lint "$CHART" -f "$CHART/values-local.yaml" >/dev/null 2>&1; then
    log_pass "Helm lint LOCAL"
  else
    log_fail "Helm lint LOCAL"
  fi

  # Test 2: Helm lint live
  if helm lint "$CHART" -f "$CHART/values-live.yaml" >/dev/null 2>&1; then
    log_pass "Helm lint LIVE"
  else
    log_fail "Helm lint LIVE"
  fi

  # Test 3: Template renders without error (local)
  if helm template t "$CHART" -f "$CHART/values-local.yaml" -n n8n-local >/dev/null 2>&1; then
    log_pass "Helm template LOCAL renders"
  else
    log_fail "Helm template LOCAL renders"
  fi

  # Test 4: Template renders without error (live)
  if helm template t "$CHART" -f "$CHART/values-live.yaml" -n n8n-live >/dev/null 2>&1; then
    log_pass "Helm template LIVE renders"
  else
    log_fail "Helm template LIVE renders"
  fi

  # Test 5: All namespaces correct in LOCAL
  LOCAL_NS=$(helm template t "$CHART" -f "$CHART/values-local.yaml" -n n8n-local 2>/dev/null | grep 'namespace:' | grep -v n8n-local | wc -l)
  if [ "$LOCAL_NS" -eq 0 ]; then
    log_pass "LOCAL: all namespaces are n8n-local"
  else
    log_fail "LOCAL: $LOCAL_NS namespaces are NOT n8n-local"
  fi

  # Test 6: All namespaces correct in LIVE
  LIVE_NS=$(helm template t "$CHART" -f "$CHART/values-live.yaml" -n n8n-live 2>/dev/null | grep 'namespace:' | grep -v n8n-live | wc -l)
  if [ "$LIVE_NS" -eq 0 ]; then
    log_pass "LIVE: all namespaces are n8n-live"
  else
    log_fail "LIVE: $LIVE_NS namespaces are NOT n8n-live"
  fi

  # Test 7: No old env refs in LOCAL render
  OLD_REFS=$(helm template t "$CHART" -f "$CHART/values-local.yaml" -n n8n-local 2>/dev/null | grep -cE 'n8n-development|n8n-qa|n8n-production' || true)
  if [ "$OLD_REFS" -eq 0 ]; then
    log_pass "LOCAL: zero old env references"
  else
    log_fail "LOCAL: found $OLD_REFS old env references"
  fi

  # Test 8: No old env refs in LIVE render
  OLD_REFS_LIVE=$(helm template t "$CHART" -f "$CHART/values-live.yaml" -n n8n-live 2>/dev/null | grep -cE 'n8n-development|n8n-qa|n8n-production' || true)
  if [ "$OLD_REFS_LIVE" -eq 0 ]; then
    log_pass "LIVE: zero old env references"
  else
    log_fail "LIVE: found $OLD_REFS_LIVE old env references"
  fi

  # Test 9: N8N image pinned (not latest)
  IMG=$(helm template t "$CHART" -f "$CHART/values-local.yaml" -n n8n-local 2>/dev/null | grep 'image: "n8nio/n8n' | head -1)
  if echo "$IMG" | grep -q ':1.19.4'; then
    log_pass "N8N image pinned to 1.19.4"
  else
    log_fail "N8N image not pinned: $IMG"
  fi

  # Test 10: Resources differ between local and live
  LOCAL_CPU=$(helm template t "$CHART" -f "$CHART/values-local.yaml" -n n8n-local 2>/dev/null | grep -A1 'limits:' | grep cpu | head -1 | tr -d ' ')
  LIVE_CPU=$(helm template t "$CHART" -f "$CHART/values-live.yaml" -n n8n-live 2>/dev/null | grep -A1 'limits:' | grep cpu | head -1 | tr -d ' ')
  if [ "$LOCAL_CPU" != "$LIVE_CPU" ]; then
    log_pass "Resources differ: local=$LOCAL_CPU vs live=$LIVE_CPU"
  else
    log_fail "Resources identical between envs: $LOCAL_CPU"
  fi

  # Test 11: Script syntax checks
  ALL_SCRIPTS_PASS=true
  for SCRIPT in scripts/deploy.sh scripts/fix-database-compatibility.sh scripts/fix-database-permissions.sh scripts/bootstrap-argocd.sh; do
    if ! bash -n "$SCRIPT" 2>/dev/null; then
      log_fail "Script syntax: $SCRIPT"
      ALL_SCRIPTS_PASS=false
    fi
  done
  if [ "$ALL_SCRIPTS_PASS" = true ]; then
    log_pass "All 4 scripts pass syntax check"
  fi

  # Test 12: ArgoCD YAML valid
  if python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" argocd/n8n-application.yaml argocd/applications/local-n8n.yaml argocd/applications/live-n8n.yaml 2>/dev/null; then
    log_pass "ArgoCD YAML valid"
  else
    log_fail "ArgoCD YAML parse error"
  fi

  echo ""
done

echo "========================================"
echo "FINAL RESULTS"
echo "========================================"
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 ALL TESTS PASSED ACROSS 3 RUNS"
  exit 0
else
  echo "💥 $FAIL FAILURES DETECTED"
  exit 1
fi
