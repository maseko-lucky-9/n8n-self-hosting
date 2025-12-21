#!/bin/bash
set -e

echo "=== Bootstrapping ArgoCD ==="

# 1. Install ArgoCD
if kubectl get ns argocd > /dev/null 2>&1; then
  echo "Namespace 'argocd' already exists."
else
  echo "Creating 'argocd' namespace..."
  kubectl create namespace argocd
fi

echo "Applying ArgoCD manifest..."
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 2. Waiting for ArgoCD
echo "Waiting for ArgoCD server to be ready (this may take a few minutes)..."
kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=300s

# 3. Apply n8n Application
echo "Applying n8n Application manifest..."
kubectl apply -f argocd/n8n-application.yaml

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
