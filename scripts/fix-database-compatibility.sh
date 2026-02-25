#!/bin/bash

# Script to fix PostgreSQL database compatibility issues
# This script provides options to resolve the "FATAL: database files are incompatible with server" error

set -euo pipefail

NAMESPACE="${1:-n8n-local}"
PVC_NAME="n8n-application-postgres-pvc"
POSTGRES_DEPLOYMENT="n8n-application-postgres"

echo "=== PostgreSQL Database Compatibility Fix ==="
echo "This script helps resolve database compatibility issues."
echo ""

# Function to check current state
check_current_state() {
    echo "Checking current state..."
    echo "1. Checking if PVC exists..."
    if kubectl get pvc $PVC_NAME -n $NAMESPACE >/dev/null 2>&1; then
        echo "   ✓ PVC $PVC_NAME exists"
        kubectl get pvc $PVC_NAME -n $NAMESPACE
    else
        echo "   ✗ PVC $PVC_NAME not found"
    fi
    
    echo ""
    echo "2. Checking PostgreSQL deployment..."
    if kubectl get deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE >/dev/null 2>&1; then
        echo "   ✓ PostgreSQL deployment exists"
        kubectl get deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE
    else
        echo "   ✗ PostgreSQL deployment not found"
    fi
    
    echo ""
    echo "3. Checking PostgreSQL pod status..."
    kubectl get pods -n $NAMESPACE -l app.kubernetes.io/component=postgres
}

# Function to clear persistent volume (WARNING: This will delete all data)
clear_persistent_volume() {
    echo ""
    echo "⚠️  WARNING: This will delete ALL data in the PostgreSQL database!"
    echo "   This action cannot be undone."
    echo ""
    read -p "Are you sure you want to continue? (yes/no): " confirm
    
    if [ "$confirm" = "yes" ]; then
        echo "Deleting PVC $PVC_NAME..."
        kubectl delete pvc $PVC_NAME -n $NAMESPACE
        
        echo "Waiting for PVC to be deleted..."
        while kubectl get pvc $PVC_NAME -n $NAMESPACE >/dev/null 2>&1; do
            echo "   Waiting for PVC deletion to complete..."
            sleep 5
        done
        
        echo "PVC deleted successfully."
        echo ""
        echo "Now redeploy the application to create a fresh database:"
        echo "   helm upgrade --install n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-local.yaml"
    else
        echo "Operation cancelled."
    fi
}

# Function to restart PostgreSQL deployment
restart_postgres() {
    echo "Restarting PostgreSQL deployment..."
    kubectl rollout restart deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE
    
    echo "Waiting for rollout to complete..."
    kubectl rollout status deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE
    
    echo "PostgreSQL deployment restarted successfully."
}

# Function to check PostgreSQL logs
check_logs() {
    echo "Checking PostgreSQL pod logs..."
    POD_NAME=$(kubectl get pods -n $NAMESPACE -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}')
    
    if [ -n "$POD_NAME" ]; then
        echo "Pod: $POD_NAME"
        echo "Recent logs:"
        kubectl logs $POD_NAME -n $NAMESPACE --tail=50
    else
        echo "No PostgreSQL pods found."
    fi
}

# Main menu
while true; do
    echo ""
    echo "Choose an option:"
    echo "1. Check current state"
    echo "2. Clear persistent volume (delete all data)"
    echo "3. Restart PostgreSQL deployment"
    echo "4. Check PostgreSQL logs"
    echo "5. Exit"
    echo ""
    read -p "Enter your choice (1-5): " choice
    
    case $choice in
        1)
            check_current_state
            ;;
        2)
            clear_persistent_volume
            ;;
        3)
            restart_postgres
            ;;
        4)
            check_logs
            ;;
        5)
            echo "Exiting..."
            exit 0
            ;;
        *)
            echo "Invalid choice. Please enter a number between 1 and 5."
            ;;
    esac
done 