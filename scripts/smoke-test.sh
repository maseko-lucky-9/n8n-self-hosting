#!/bin/bash
# smoke-test.sh — Live cluster integration smoke test for n8n-live
#
# Checks that the deployed stack is healthy: pods running, endpoints reachable,
# secrets synced, last backup succeeded, ArgoCD in sync.
#
# Usage:
#   bash scripts/smoke-test.sh               # run all checks
#   bash scripts/smoke-test.sh --namespace n8n-staging  # override namespace
#
# Run on: any machine with kubectl access to the cluster (or via SSH to homelab)
# Exit code: 0 = all checks passed, 1 = one or more checks failed

set -uo pipefail

NAMESPACE="${NAMESPACE:-n8n-live}"
KUBECTL="microk8s kubectl"
PASS=0
FAIL=0

# Allow namespace override via flag
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== n8n Smoke Test (namespace: ${NAMESPACE}) ==="
echo ""

# ── 1. Pod readiness ────────────────────────────────────────────────────────
echo "1. Pod readiness"

NOT_READY=$(${KUBECTL} get pods -n "${NAMESPACE}" \
  --field-selector=status.phase!=Succeeded \
  -o jsonpath='{range .items[?(@.status.phase!="Running")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -v '^$' || true)

if [[ -z "${NOT_READY}" ]]; then
  pass "All pods Running"
else
  fail "Pods not Running: $(echo "${NOT_READY}" | tr '\n' ' ')"
fi

RESTARTS=$(${KUBECTL} get pods -n "${NAMESPACE}" \
  -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.name}={.restartCount}{"\n"}{end}{end}' 2>/dev/null | \
  awk -F= '$2 > 5 {print $1"("$2")"}' | tr '\n' ' ' || true)

if [[ -z "${RESTARTS}" ]]; then
  pass "No containers with >5 restarts"
else
  fail "High restart counts: ${RESTARTS}"
fi

echo ""

# ── 2. n8n HTTP health ───────────────────────────────────────────────────────
echo "2. n8n HTTP health"

N8N_POD=$(${KUBECTL} get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=n8n-application \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [[ -n "${N8N_POD}" ]]; then
  HEALTH=$(${KUBECTL} exec -n "${NAMESPACE}" "${N8N_POD}" -- \
    wget -qO- --timeout=10 "http://localhost:5678/healthz" 2>/dev/null || true)
  if echo "${HEALTH}" | grep -q '"status"'; then
    pass "n8n /healthz responds: ${HEALTH}"
  else
    fail "n8n /healthz returned unexpected response: '${HEALTH}'"
  fi
else
  fail "No running n8n pod found in ${NAMESPACE}"
fi

echo ""

# ── 3. ExternalSecret sync ───────────────────────────────────────────────────
echo "3. ExternalSecret sync"

ES_STATUSES=$(${KUBECTL} get externalsecret -n "${NAMESPACE}" \
  -o jsonpath='{range .items[*]}{.metadata.name}={.status.conditions[0].reason}{"\n"}{end}' 2>/dev/null || true)

while IFS='=' read -r name reason; do
  [[ -z "${name}" ]] && continue
  if [[ "${reason}" == "SecretSynced" ]]; then
    pass "ExternalSecret ${name}: Synced"
  else
    fail "ExternalSecret ${name}: ${reason:-Unknown}"
  fi
done <<< "${ES_STATUSES}"

echo ""

# ── 4. Backup CronJob last run ───────────────────────────────────────────────
echo "4. Backup CronJob"

LAST_JOB=$(${KUBECTL} get jobs -n "${NAMESPACE}" \
  -o jsonpath='{range .items[*]}{.metadata.name} {.status.succeeded} {.status.failed}{"\n"}{end}' 2>/dev/null | \
  grep 'backup' | tail -1 || true)

if [[ -z "${LAST_JOB}" ]]; then
  pass "No backup jobs found (CronJob may not have run yet)"
else
  JOB_NAME=$(echo "${LAST_JOB}" | awk '{print $1}')
  JOB_OK=$(echo "${LAST_JOB}" | awk '{print $2}')
  JOB_FAIL=$(echo "${LAST_JOB}" | awk '{print $3}')
  if [[ "${JOB_OK}" == "1" ]]; then
    pass "Last backup job ${JOB_NAME}: succeeded"
  else
    fail "Last backup job ${JOB_NAME}: succeeded=${JOB_OK} failed=${JOB_FAIL}"
  fi
fi

echo ""

# ── 5. ArgoCD sync status ────────────────────────────────────────────────────
echo "5. ArgoCD sync"

ARGOCD_APP=$(${KUBECTL} get application n8n-live -n argocd \
  -o jsonpath='{.status.sync.status} {.status.health.status}' 2>/dev/null || true)

if [[ -n "${ARGOCD_APP}" ]]; then
  SYNC_STATUS=$(echo "${ARGOCD_APP}" | awk '{print $1}')
  HEALTH_STATUS=$(echo "${ARGOCD_APP}" | awk '{print $2}')
  if [[ "${SYNC_STATUS}" == "Synced" && "${HEALTH_STATUS}" == "Healthy" ]]; then
    pass "ArgoCD n8n-live: Synced + Healthy"
  else
    fail "ArgoCD n8n-live: sync=${SYNC_STATUS} health=${HEALTH_STATUS}"
  fi
else
  fail "ArgoCD Application n8n-live not found"
fi

echo ""

# ── 6. PVC bound ─────────────────────────────────────────────────────────────
echo "6. PVC status"

PVCS=$(${KUBECTL} get pvc -n "${NAMESPACE}" \
  -o jsonpath='{range .items[*]}{.metadata.name}={.status.phase}{"\n"}{end}' 2>/dev/null || true)

while IFS='=' read -r name phase; do
  [[ -z "${name}" ]] && continue
  if [[ "${phase}" == "Bound" ]]; then
    pass "PVC ${name}: Bound"
  else
    fail "PVC ${name}: ${phase}"
  fi
done <<< "${PVCS}"

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
echo "========================================"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "========================================"

[[ "${FAIL}" -eq 0 ]] || exit 1
