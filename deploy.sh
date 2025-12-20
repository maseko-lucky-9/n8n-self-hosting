#!/bin/bash

# Deployment script for n8n-application
# Standardizes release name and paths

set -e

RELEASE_NAME="n8n-application"
NAMESPACE="n8n-development"
CHART_PATH="./helm/n8n-application"
VALUES_FILE="./helm/n8n-application/values-dev.yaml"

echo "=== Deploying $RELEASE_NAME to $NAMESPACE ==="

# Check if we are in the root directory
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
