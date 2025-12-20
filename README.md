# n8n Self-Hosting on Kubernetes

This repository contains the Helm chart and configuration for self-hosting n8n with a PostgreSQL database on Kubernetes.

## Prerequisites

- **Kubernetes Cluster**: Minikube, Kind, or a managed cluster.
- **kubectl**: Installed and configured.
- **Helm**: v3+ installed.
- **WSL (Windows Users)**: Recommended for running the deployment scripts.

## Quick Start (Installation)

We provide a deployment script to handle path resolution and release naming automatically.

1.  **Clone the repository**:

    ```bash
    git clone <your-repo-url>
    cd n8n-self-hosting
    ```

2.  **Deploy**:
    Run the deployment script from the root of the repository:

    ```bash
    ./deploy.sh
    ```

    _Note: This script installs/upgrades the `n8n-application` release using `values-dev.yaml`._

3.  **Verify Status**:
    ```bash
    kubectl get pods -n n8n-development
    ```

## Configuration

The main configuration file is [`helm/n8n-application/values-dev.yaml`](./helm/n8n-application/values-dev.yaml).

Key configurations:

- **Database**: Defaults to checking for a `postgres-secret` (auto-generated if ExternalSecrets is disabled).
- **External Secrets**: Disabled by default (`externalSecrets.enabled: false`) for easier local development.
- **Ingress**: Configured for `n8n.local` with Kong annotation support.

## Troubleshooting & Known Issues

If you encounter issues during deployment, check the following common fixes that have been applied or might be needed.

### 1. Database Migration Error: `function gen_random_uuid() does not exist`

**Symptoms**: n8n pod restarts with log error: `Error running database migrations`.
**Cause**: The PostgreSQL image doesn't enable the `pgcrypto` extension by default, and if the volume persists, init scripts won't run again.
**Fix**:
Execute into the postgres pod and enable the extension manually:

```bash
# Get the postgres pod name
kubectl get pods -n n8n-development

# Connect and run the SQL command
kubectl exec -n n8n-development <POSTGRES_POD_NAME> -- psql -U n8n -d n8n -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

_Then restart the n8n pod._

### 2. Permission Denied / CrashLoopBackOff

**Symptoms**: n8n pod crashes with `EACCES: permission denied, mkdir '/.n8n'`.
**Cause**: UID mismatch. The volume is owned by UID 1000, but n8n might try to run as 999 or root.
**Fix**: Ensure `n8n-deployment.yaml` SecurityContext is set to `runAsUser: 1000` and `fsGroup: 1000`. (This is already configured in the latest version).

### 3. Database Connection Failed (`EAI_AGAIN` or `Connection Refused`)

**Symptoms**: n8n logs show `getaddrinfo EAI_AGAIN postgres-service`.
**Cause**: Service selector mismatch. The `postgres-service` didn't select any pods.
**Fix**: The `postgres-service.yaml` has been updated to use dynamic selectors (`app.kubernetes.io/name`). Ensure your Helm chart is up to date.

### 4. Database Name Mismatch

**Symptoms**: Log error `database "n8n_dev" does not exist`.
**Cause**: Discrepancy between the database created (`n8n` in values.yaml) and the database n8n expects (`n8n_dev`).
**Fix**: Both `values-dev.yaml` and `n8n-deployment.yaml` are now synchronized to use `n8n`.

## Manual Verification

To verify the deployment is working correctly:

1.  **Check Pods**:

    ```bash
    kubectl get pods -n n8n-development
    ```

    _All pods should be 1/1 Running._

2.  **Check Logs**:

    ```bash
    kubectl logs -n n8n-development -l service=n8n
    ```

    _Look for "Editor is now accessible via: ..."_

3.  **Port Forward (Local Access)**:
    ```bash
    kubectl port-forward -n n8n-development svc/n8n 5678:5678
    ```
    Access at http://localhost:5678
