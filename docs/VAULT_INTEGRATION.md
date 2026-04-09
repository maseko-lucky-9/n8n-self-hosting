# Vault Integration Guide

This guide documents how N8N retrieves secrets from HashiCorp Vault running on the same MicroK8s cluster, using the External Secrets Operator (ESO) with Kubernetes authentication.

## Architecture Overview

```
Vault (vault namespace)
  └── KV v2 engine @ secret/
        └── secret/n8n/live/postgres   ← Postgres credentials

ESO SecretStore (n8n-live namespace)
  └── vault-backend  ← authenticates via Kubernetes SA JWT

ExternalSecret (n8n-live namespace)
  └── postgres-external-secret
        └── syncs → K8s Secret: postgres-secret (every 1h)

N8N + PostgreSQL Pods
  └── consume postgres-secret as env vars
```

## Prerequisites

- HashiCorp Vault deployed and **unsealed** (see [HashiCorp-Vault repo](https://github.com/maseko-lucky-9/HashiCorp-Vault))
- External Secrets Operator installed on the cluster
- `n8n-live` namespace exists and is labeled

---

## Step 1 — Install External Secrets Operator

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace
```

Verify:
```bash
kubectl get pods -n external-secrets
```

---

## Step 2 — Unseal Vault (after every restart)

Vault seals itself on pod restart. Unseal with your saved keys:

```bash
kubectl exec -n vault vault-0 -- vault operator unseal <UNSEAL_KEY_1>
kubectl exec -n vault vault-0 -- vault operator unseal <UNSEAL_KEY_2>
kubectl exec -n vault vault-0 -- vault operator unseal <UNSEAL_KEY_3>

# Verify
kubectl exec -n vault vault-0 -- vault status
```

Expected: `Sealed: false`

> **Store your unseal keys and root token securely.** They are only shown once during `init-vault.sh`. If lost, Vault must be re-initialized (data loss).

---

## Step 3 — Enable Kubernetes Auth (one-time)

```bash
# Login with root token
kubectl exec -n vault vault-0 -- vault login <ROOT_TOKEN>

# Enable Kubernetes auth
kubectl exec -n vault vault-0 -- vault auth enable kubernetes

# Configure it to use the in-cluster K8s API
kubectl exec -n vault vault-0 -- vault write auth/kubernetes/config \
  kubernetes_host=https://kubernetes.default.svc:443

# Verify
kubectl exec -n vault vault-0 -- vault auth list
```

---

## Step 4 — Apply the N8N Policy (one-time)

Write the `n8n-readonly` policy that grants ESO read access to N8N secrets:

```bash
kubectl exec -n vault vault-0 -c vault -- \
  sh -c 'VAULT_ADDR=http://127.0.0.1:8200 vault policy write n8n-readonly - <<EOF
path "kv/data/secret/n8n/+/*" {
  capabilities = ["read"]
}
path "kv/metadata/secret/n8n/+/*" {
  capabilities = ["read", "list"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/renew-self" {
  capabilities = ["update"]
}
EOF'
```

Verify:
```bash
kubectl exec -n vault vault-0 -- vault policy read n8n-readonly
```

---

## Step 5 — Create Kubernetes Auth Role for N8N (one-time)

```bash
kubectl exec -n vault vault-0 -- vault write \
  auth/kubernetes/role/n8n-readonly \
  bound_service_account_names=external-secrets-n8n \
  bound_service_account_namespaces=n8n-live \
  policies=n8n-readonly \
  ttl=1h \
  max_ttl=24h

# Verify
kubectl exec -n vault vault-0 -- vault read auth/kubernetes/role/n8n-readonly
```

> **Note:** Two Kubernetes auth roles exist for n8n:
> - `n8n-readonly` — binds SA `external-secrets-n8n` for ESO secret syncing (this step)
> - `n8n-live` — binds SA `n8n-application` for direct pod access to Vault (used by Vault Agent Injector if enabled)

---

## Step 6 — Store Postgres Secrets in Vault (one-time, update on rotation)

```bash
kubectl exec -n vault vault-0 -- vault kv put kv/secret/n8n/live/postgres \
  data='{"POSTGRES_USER":"n8n_live","POSTGRES_PASSWORD":"<SECURE_PASS>","POSTGRES_DB":"n8n","POSTGRES_NON_ROOT_USER":"n8n_app","POSTGRES_NON_ROOT_PASSWORD":"<SECURE_PASS_2>"}'
```

Verify:
```bash
kubectl exec -n vault vault-0 -- vault kv get kv/secret/n8n/live/postgres
```

> Use `openssl rand -base64 32` to generate secure passwords.

---

## Step 6b — Store App Secrets in Vault (one-time)

```bash
# Extract the existing encryption key from the running n8n pod first:
kubectl exec -n n8n-live <n8n-pod> -c n8n -- cat /home/node/.n8n/config

kubectl exec -n vault vault-0 -- vault kv put kv/secret/n8n/live/app \
  N8N_ENCRYPTION_KEY="<EXTRACTED_KEY>" \
  N8N_WEBHOOK_URL="https://n8n.homelab.local"
```

> **CRITICAL:** Use the EXTRACTED encryption key, not a new one. Generating a new key will make all existing workflow credentials unrecoverable.

---

## Step 7 — Label the N8N Namespace for NetworkPolicy

```bash
kubectl label namespace n8n-live vault-client=true --overwrite

# Verify
kubectl get namespace n8n-live --show-labels
```

This label is required by Vault's default-deny `NetworkPolicy` to permit traffic from the `n8n-live` namespace on port 8200.

---

## Step 8 — Deploy N8N with Live Values

The Helm chart's `values-live.yaml` has ESO pre-configured. Deploy:

```bash
./scripts/deploy.sh live
```

This creates:
- `SecretStore/vault-backend` — ESO ↔ Vault connection using the N8N service account JWT
- `ExternalSecret/postgres-external-secret` — syncs every `1h` from `secret/n8n/live/postgres` into `K8s Secret: postgres-secret`

Verify ESO is syncing:
```bash
kubectl get externalsecret -n n8n-live
kubectl describe externalsecret postgres-external-secret -n n8n-live
```

Expected status: `Ready: True`, `SecretSynced`

---

## Secret Rotation

To rotate Postgres passwords:

1. **Update the secret in Vault:**
   ```bash
   kubectl exec -n vault vault-0 -- vault kv patch kv/secret/n8n/live/postgres \
     POSTGRES_PASSWORD="<NEW_PASS>" \
     POSTGRES_NON_ROOT_PASSWORD="<NEW_PASS_2>"
   ```

2. **Wait for ESO to sync** (up to 1 hour), or force an immediate sync:
   ```bash
   kubectl annotate externalsecret postgres-external-secret \
     -n n8n-live force-sync=$(date +%s) --overwrite
   ```

3. **Restart N8N and Postgres** to pick up the new K8s Secret values:
   ```bash
   kubectl rollout restart deployment n8n -n n8n-live
   kubectl rollout restart statefulset/n8n-application-postgres -n n8n-live
   ```

> **Important:** N8N does not hot-reload environment variables. A pod restart is always required after secret rotation.

---

## Troubleshooting

### ESO shows `SecretSyncedError`

```bash
kubectl describe externalsecret postgres-external-secret -n n8n-live
```

Common causes:
| Error | Fix |
|---|---|
| `permission denied` | Re-check `n8n-readonly` policy and auth role SA binding |
| `connection refused` | Vault is sealed — unseal it (Step 2) |
| `no handler for route` | Kubernetes auth not enabled — run Step 3 |
| `namespace not labeled` | Run Step 7 |

### Check which token/identity ESO is using

```bash
kubectl exec -n vault vault-0 -- vault token lookup
```

### Manually verify the secret path exists

```bash
kubectl exec -n vault vault-0 -- vault kv get kv/secret/n8n/live/postgres
```

### Verify the K8s Secret was created

```bash
kubectl get secret postgres-secret -n n8n-live
kubectl describe secret postgres-secret -n n8n-live
```

---

## ESO Configuration Reference (`values-live.yaml`)

```yaml
externalSecrets:
  enabled: true
  refreshInterval: "1h"
  vault:
    address: "https://vault.vault.svc.cluster.local:8200"
    kvPath: "kv"
    kvVersion: "v2"
    secretPath: "secret/n8n/live/postgres"
    appSecretPath: "secret/n8n/live/app"
    auth:
      mountPath: "kubernetes"
      role: "n8n-readonly"
      serviceAccount: "external-secrets-n8n"
```

