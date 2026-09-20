#!/bin/bash
set -e

# OBSOLETE — kept for reference only.
# On the homelab cluster ArgoCD is already installed (v3.x) and the n8n-live Application is owned by
# homelab-infra's monitoring-root app. Running this would install ArgoCD v2.13.3 over it (a
# cluster-wide downgrade), apply an n8n-root app whose auto-sync/prune fights monitoring-root and
# deploys n8n-local onto the production node, and print the ArgoCD admin password to stdout.
echo "Refusing: this bootstrap script is obsolete and unsafe on the homelab cluster." >&2
echo "ArgoCD and the n8n-live Application are managed by homelab-infra (monitoring-root)." >&2
echo "Deploy/sync -> docs/runbook.md section 4." >&2
exit 1

echo "=== Bootstrapping ArgoCD ==="

# 1. Install ArgoCD
if kubectl get ns argocd > /dev/null 2>&1; then
  echo "Namespace 'argocd' already exists."
else
  echo "Creating 'argocd' namespace..."
  kubectl create namespace argocd
fi

echo "Applying ArgoCD manifest..."
ARGOCD_VERSION="v2.13.3"
kubectl apply -n argocd -f "https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml"

# 2. Waiting for ArgoCD
echo "Waiting for ArgoCD server to be ready (this may take a few minutes)..."
kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=300s

# 3. Apply n8n Application
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$SCRIPT_DIR/.."
echo "Applying n8n Application manifest..."
kubectl apply -f "$ROOT_DIR/argocd/n8n-application.yaml"

echo "=== Bootstrap Complete ==="
echo "ArgoCD is running and n8n-application has been configured."
echo -n "Initial Password: "
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
echo ""
echo "----------------------------------------------------------------"
echo "Access the dashboard via:"
echo "kubectl port-forward -n argocd svc/argocd-server 8080:443"
echo "URL: https://localhost:8080"
echo "Username: admin"
