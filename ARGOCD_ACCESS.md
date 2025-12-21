# ArgoCD Access & Usage Guide

This document provides a quick reference for starting, accessing, and using the ArgoCD dashboard to manage your n8n deployment.

## 1. Start / Install ArgoCD

If ArgoCD is not already running or you are setting up a fresh cluster, use the automated bootstrap script:

```bash
./bootstrap-argocd.sh
```

_This script installs ArgoCD, applies the n8n application manifest, and waits for the server to be ready._

## 2. Access the Dashboard

To access the web interface from your browser, you must port-forward the ArgoCD server to your local machine.

### Command

Run this in a separate terminal window (keep it open):

```powershell
wsl kubectl port-forward -n argocd svc/argocd-server 8080:443
```

### Browser URL

Open the following link:
**[https://localhost:8080](https://localhost:8080)**

> **Note**: You will see a "Your connection is not private" warning because ArgoCD uses a self-signed certificate. You can safely click "Advanced" -> "Proceed to localhost (unsafe)" for local development.

## 3. Login Credentials

- **Username**: `admin`
- **Password**:
  To retrieve the initial admin password, run:
  ```bash
  wsl kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
  ```

## 4. Managing n8n Application

Once logged in, you should see the `n8n-application` tile.

### Syncing Changes

ArgoCD syncs configuration from your **GitHub Repository**, not your local computer.

1.  Make changes locally (e.g., edit `values-dev.yaml`).
2.  Push changes to GitHub:
    ```bash
    git add .
    git commit -m "Update config"
    git push origin main
    ```
3.  In ArgoCD, click **Refresh** then **Sync** to apply the changes to your cluster.

### Troubleshooting Sync Issues

If the sync fails or the application status is "Degraded":

- Check the "Events" tab in ArgoCD for error messages.
- Ensure your `n8n-application.yaml` points to the correct GitHub URL.
- Verify that `_helpers.tpl` and other templates are present in the remote repository.
