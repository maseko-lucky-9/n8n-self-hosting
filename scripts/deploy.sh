#!/bin/bash

# Deployment script for n8n-application (LOCAL ONLY)
# Usage: ./scripts/deploy.sh [local]
# Defaults to 'local' if no argument provided.
# n8n-live is deployed by ArgoCD — see docs/runbook.md §4 (sync) and §13 (upgrade).

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$SCRIPT_DIR/.."

ENV="${1:-local}"

case "$ENV" in
    local)
        NAMESPACE="n8n-local"
        VALUES_FILE="$ROOT_DIR/helm/n8n-application/values-local.yaml"
        ;;
    live)
        # n8n-live is ArgoCD-managed and has no Helm release. A helm upgrade here aborts on
        # ownership conflicts, or — if forced — adopts live resources (including the data PVCs)
        # into a new release that a later `helm uninstall` would delete.
        echo "Refusing: n8n-live is deployed by ArgoCD, not Helm." >&2
        echo "  Deploy:  merge to main, then sync  -> docs/runbook.md section 4" >&2
        echo "  Upgrade: staged cutover            -> docs/runbook.md section 13" >&2
        exit 1
        ;;
    *)
        echo "Error: Unknown environment '$ENV'. Use 'local'."
        exit 1
        ;;
esac

RELEASE_NAME="n8n-application"
CHART_PATH="$ROOT_DIR/helm/n8n-application"

echo "=== Deploying $RELEASE_NAME to $NAMESPACE (env: $ENV) ==="

# Check if chart directory exists
if [ ! -d "$CHART_PATH" ]; then
    echo "Error: Chart directory not found at $CHART_PATH"
    echo "Please run this script from the repository root."
    exit 1
fi

if [ ! -f "$VALUES_FILE" ]; then
    echo "Error: Values file not found at $VALUES_FILE"
    exit 1
fi

HELM_CMD="helm"
if ! command -v helm &> /dev/null; then
    if command -v microk8s &> /dev/null; then
        HELM_CMD="microk8s helm3"
    else
        echo "Error: Neither 'helm' nor 'microk8s helm3' found in PATH."
        exit 1
    fi
fi

echo "Running helm upgrade --install (using: $HELM_CMD)..."
$HELM_CMD upgrade --install "$RELEASE_NAME" "$CHART_PATH" -f "$VALUES_FILE" -n "$NAMESPACE" --create-namespace

echo ""
echo "Deployment command executed successfully."
echo "Check status with: kubectl get all -n $NAMESPACE"
