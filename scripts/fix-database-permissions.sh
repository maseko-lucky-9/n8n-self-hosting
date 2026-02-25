#!/bin/bash

# Script to fix PostgreSQL database permissions for n8n
# This script resolves the "permission denied for schema public" erro

set -euo pipefail

NAMESPACE="${1:-n8n-local}"
POSTGRES_DEPLOYMENT="n8n-application-postgres"
N8N_DEPLOYMENT="n8n"

echo "=== n8n Database Permissions Fix ==="
echo "This script fixes the 'permission denied for schema public' error."
echo ""

# Function to check current state
check_current_state() {
    echo "Checking current state..."
    echo "1. Checking PostgreSQL deployment..."
    if kubectl get deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE >/dev/null 2>&1; then
        echo "   ✓ PostgreSQL deployment exists"
        kubectl get deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE
    else
        echo "   ✗ PostgreSQL deployment not found"
    fi
    
    echo ""
    echo "2. Checking n8n deployment..."
    if kubectl get deployment $N8N_DEPLOYMENT -n $NAMESPACE >/dev/null 2>&1; then
        echo "   ✓ n8n deployment exists"
        kubectl get deployment $N8N_DEPLOYMENT -n $NAMESPACE
    else
        echo "   ✗ n8n deployment not found"
    fi
    
    echo ""
    echo "3. Checking PostgreSQL pod status..."
    kubectl get pods -n $NAMESPACE -l app.kubernetes.io/component=postgres
    
    echo ""
    echo "4. Checking n8n pod status..."
    kubectl get pods -n $NAMESPACE -l service=n8n
}

# Function to restart PostgreSQL deployment
restart_postgres() {
    echo "Restarting PostgreSQL deployment to apply new permissions..."
    kubectl rollout restart deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE
    
    echo "Waiting for PostgreSQL rollout to complete..."
    kubectl rollout status deployment $POSTGRES_DEPLOYMENT -n $NAMESPACE
    
    echo "PostgreSQL deployment restarted successfully."
}

# Function to restart n8n deployment
restart_n8n() {
    echo "Restarting n8n deployment..."
    kubectl rollout restart deployment $N8N_DEPLOYMENT -n $NAMESPACE
    
    echo "Waiting for n8n rollout to complete..."
    kubectl rollout status deployment $N8N_DEPLOYMENT -n $NAMESPACE
    
    echo "n8n deployment restarted successfully."
}

# Function to check PostgreSQL logs
check_postgres_logs() {
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

# Function to check n8n logs
check_n8n_logs() {
    echo "Checking n8n pod logs..."
    POD_NAME=$(kubectl get pods -n $NAMESPACE -l service=n8n -o jsonpath='{.items[0].metadata.name}')
    
    if [ -n "$POD_NAME" ]; then
        echo "Pod: $POD_NAME"
        echo "Recent logs:"
        kubectl logs $POD_NAME -n $NAMESPACE --tail=50
    else
        echo "No n8n pods found."
    fi
}

# Function to apply the fix
apply_fix() {
    echo "Applying database permissions fix..."
    
    # Restart PostgreSQL first to apply new permissions
    restart_postgres
    
    # Wait a bit for PostgreSQL to be ready
    echo "Waiting for PostgreSQL to be ready..."
    sleep 30
    
    # Restart n8n to use the updated database permissions
    restart_n8n
    
    echo ""
    echo "✅ Fix applied successfully!"
    echo ""
    echo "The following changes were made:"
    echo "1. Enhanced PostgreSQL init script with proper user permissions"
    echo "2. Updated database host configuration"
    echo "3. Restarted both PostgreSQL and n8n deployments"
    echo ""
    echo "Please wait a few minutes for the services to fully start up."
}

# Main menu
while true; do
    echo ""
    echo "Choose an option:"
    echo "1. Check current state"
    echo "2. Apply database permissions fix"
    echo "3. Restart PostgreSQL deployment"
    echo "4. Restart n8n deployment"
    echo "5. Check PostgreSQL logs"
    echo "6. Check n8n logs"
    echo "7. Exit"
    echo ""
    read -p "Enter your choice (1-7): " choice
    
    case $choice in
        1)
            check_current_state
            ;;
        2)
            apply_fix
            ;;
        3)
            restart_postgres
            ;;
        4)
            restart_n8n
            ;;
        5)
            check_postgres_logs
            ;;
        6)
            check_n8n_logs
            ;;
        7)
            echo "Exiting..."
            exit 0
            ;;
        *)
            echo "Invalid choice. Please enter a number between 1 and 7."
            ;;
    esac
done 