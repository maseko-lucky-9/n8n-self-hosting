#!/bin/bash

# Deployment script for n8n-application
# Usage: ./scripts/deploy.sh [local|live]
# Defaults to 'local' if no argument provided

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
        NAMESPACE="n8n-live"
        VALUES_FILE="$ROOT_DIR/helm/n8n-application/values-live.yaml"
        ;;
    *)
        echo "Error: Unknown environment '$ENV'. Use 'local' or 'live'."
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

echo "Running helm upgrade --install..."
helm upgrade --install "$RELEASE_NAME" "$CHART_PATH" -f "$VALUES_FILE" -n "$NAMESPACE" --create-namespace

echo ""
echo "Deployment command executed successfully."
echo "Check status with: kubectl get all -n $NAMESPACE"
