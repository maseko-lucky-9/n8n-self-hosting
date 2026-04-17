## Project: n8n Self-Hosting

Helm chart + GitOps config for self-hosted n8n on Kubernetes. Two environments:

| Env     | Runtime          | Namespace  | Values file          |
|---------|------------------|------------|----------------------|
| `local` | Minikube (WSL)   | `n8n-local`| `values-local.yaml`  |
| `live`  | MicroK8s (Ubuntu)| `n8n-live` | `values-live.yaml`   |

---

## Tech Stack

- **Helm** (v3) — chart at `helm/n8n-application/`
- **ArgoCD** — App of Apps pattern; root app at `argocd/n8n-application.yaml`, per-env apps in `argocd/applications/`
- **PostgreSQL 16-alpine** — StatefulSet, in-cluster; `pgcrypto` extension required
- **Redis 7-alpine** — queue mode (main + worker architecture)
- **External Secrets Operator (ESO)** — live only; pulls from HashiCorp Vault KV v2
- **Prometheus + Grafana** — ServiceMonitor, PrometheusRules, Grafana dashboard manifests included

---

## Key Conventions

- Deploy via `./scripts/deploy.sh [live]` — handles release naming and path resolution
- All secrets in `live` come from Vault (`kv/secret/n8n/live/*`) via ESO; never commit real credentials
- Ingress in `live` is **disabled** in this chart — managed externally by `homelab-infra/ingress/manifests/n8n-ingress.yaml`
- Push directly to `main` — no feature branches

---

## Live Environment Constraints

- **MicroK8s ingress**: uses `ingress` namespace (not `ingress-nginx`); blocks `configuration-snippet` annotations; silently drops bad configs
- **LimitRange**: enforces `min.cpu=50m` per container in `n8n-live` — every container must request >= 50m CPU
- **TLS**: terminated at the nginx ingress layer; n8n receives plain HTTP internally; never enable TLS in ingress without a working cert-manager ClusterIssuer
- **Backup CronJob**: had a 3-layer failure (NetworkPolicy blocked egress, SCRAM auth drift, wrong DB user) — now fixed; NetworkPolicy must allow backup pod -> postgres egress, and DB user must be `n8n_live`
- **Storage class**: `microk8s-hostpath` for all PVCs in live
- **Vault TLS**: in-cluster Vault uses HTTPS; `vault-tls-ca` Secret with `ca.crt` must exist in `n8n-live` before ESO can authenticate

---

## Docs Index

| File | Purpose |
|------|---------|
| `docs/VAULT_INTEGRATION.md` | ESO + Vault setup, unseal, policy, secret rotation |
| `docs/NETWORK_EXPOSURE_GUIDE.md` | Ingress topology and homelab-infra split |
| `docs/ARGOCD_ACCESS.md` | ArgoCD dashboard access |
| `docs/runbook.md` | Operational runbook |
| `docs/production-checklist.md` | Pre-go-live checklist |
