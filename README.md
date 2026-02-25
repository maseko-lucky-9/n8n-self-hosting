# n8n Self-Hosting on Kubernetes

This repository contains the Helm chart and configuration for self-hosting n8n with a PostgreSQL database on Kubernetes.

## Environments

| Environment | Runtime           | Namespace   | Values File         |
| ----------- | ----------------- | ----------- | ------------------- |
| **Local**   | WSL + Minikube    | `n8n-local` | `values-local.yaml` |
| **Live**    | Ubuntu + MicroK8s | `n8n-live`  | `values-live.yaml`  |

## Prerequisites

- **Kubernetes Cluster**: Minikube (local) or MicroK8s (live).
- **kubectl**: Installed and configured.
- **Helm**: v3+ installed.
- **WSL (Windows Users)**: Recommended for running the deployment scripts.

## Quick Start (Local Development)

We provide a deployment script to handle path resolution and release naming automatically.

1.  **Clone the repository**:

    ```bash
    git clone <your-repo-url>
    cd n8n-self-hosting
    ```

2.  **Deploy** (defaults to local environment):

    ```bash
    ./scripts/deploy.sh          # deploys to n8n-local
    ./scripts/deploy.sh live     # deploys to n8n-live
    ```

3.  **Verify Status**:
    ```bash
    kubectl get pods -n n8n-local
    ```

## Configuration

The main configuration files are:

- [`helm/n8n-application/values-local.yaml`](./helm/n8n-application/values-local.yaml) — Local development
- [`helm/n8n-application/values-live.yaml`](./helm/n8n-application/values-live.yaml) — Production (MicroK8s)

Key configurations:

- **Database**: Uses a `postgres-secret` Kubernetes Secret for credentials.
- **External Secrets**: Disabled for local, enabled for live (Vault/ESO).
- **Ingress**: `n8n.local` for local dev, real domain for live. See [`docs/NETWORK_EXPOSURE_GUIDE.md`](docs/NETWORK_EXPOSURE_GUIDE.md) for details.

## ArgoCD (GitOps)

This repository uses an App of Apps pattern:

- **Root app** (`argocd/n8n-application.yaml`) manages child applications
- **Child apps** in `argocd/applications/` deploy the Helm chart per environment
- Local environment: auto-sync enabled
- Live environment: manual sync (triggered via CI or ArgoCD UI)

See [`docs/ARGOCD_ACCESS.md`](docs/ARGOCD_ACCESS.md) for dashboard access.

## Troubleshooting & Known Issues

### 1. Database Migration Error: `function gen_random_uuid() does not exist`

**Symptoms**: n8n pod restarts with log error: `Error running database migrations`.
**Cause**: The PostgreSQL image doesn't enable the `pgcrypto` extension by default.
**Fix**:
Execute into the postgres pod and enable the extension manually:

```bash
kubectl get pods -n n8n-local
kubectl exec -n n8n-local <POSTGRES_POD_NAME> -- psql -U n8n -d n8n -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
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

## Manual Verification

To verify the deployment is working correctly:

1.  **Check Pods**:

    ```bash
    kubectl get pods -n n8n-local
    ```

    _All pods should be 1/1 Running._

2.  **Check Logs**:

    ```bash
    kubectl logs -n n8n-local -l service=n8n
    ```

    _Look for "Editor is now accessible via: ..."_

3.  **Port Forward (Local Access)**:
    ```bash
    kubectl port-forward -n n8n-local svc/n8n 5678:5678
    ```
    Access at http://localhost:5678
