# Infrastructure Audit Report: n8n Self-Hosting

**Date:** 2026-04-08
**Author:** Infrastructure Audit
**Scope:** Cross-repo audit — `n8n/n8n` (upstream), `n8n-self-hosting`, `homelab-infra`
**Status:** Remediation complete (17/17 gaps implemented)

---

## Section 1: Executive Summary

- **Restart storm (CRITICAL):** n8n accumulated 19 restarts in 7 days and postgres 39 restarts in 23 days. Root cause is the `sleep 5; n8n start` startup hack combined with a Calico hostNetwork bug that delays CoreDNS readiness after node restart. Replaced with a `pg_isready` init container (GAP-001, implemented).
- **Encryption key risk (CRITICAL):** No `N8N_ENCRYPTION_KEY` was set. n8n auto-generates a key on the PVC, meaning any pod replacement or PVC migration silently breaks all stored credentials. Key must be extracted, stored in Vault, and injected via ESO (GAP-002, implemented).
- **Dual ingress conflict (CRITICAL):** Both the Helm chart and `homelab-infra` were creating Ingress resources for `n8n.homelab.local`. Helm-managed ingress is now disabled; `homelab-infra` owns ingress exclusively (GAP-003, implemented).
- **Missing webhook URL (CRITICAL):** `N8N_WEBHOOK_URL` was not configured anywhere. Without it, externally triggered webhooks silently fail because n8n constructs callback URLs from the wrong base (GAP-004, implemented).
- **Partial secrets management (HIGH):** ESO/Vault integration covers postgres credentials correctly, but n8n application secrets (encryption key, webhook URL) were unmanaged. Added `n8n-app-secret` ExternalSecret and a new Vault path `kv/secret/n8n/live/app` (GAP-005, implemented).
- **No postgres metrics (HIGH):** No `postgres_exporter` sidecar existed. Postgres health was opaque to Prometheus. Added sidecar, metrics port, ServiceMonitor endpoint, and 4 new PrometheusRule alerts (GAP-006, implemented).
- **Resource over-provisioning (MEDIUM):** Measured utilization was 2.8% CPU and 27.5% memory against configured limits. Limits are 10–35x above actual usage. Deferred for rightsizing after stable baseline is established (GAP-017, deferred).
- **Vault role TTL gap (HIGH):** The `n8n-live` Vault role had no `max_ttl`, allowing indefinite token renewal without re-authentication. Set `max_ttl: 24h` to enforce periodic credential rotation (GAP-009, implemented).
- **Stale documentation (HIGH):** `VAULT_INTEGRATION.md` contained 6+ errors including wrong mount point, role names, and SA names. Four additional docs referenced outdated paths and components. All corrected in Batch 3 (GAP-008, implemented).
- **17 gaps total identified** across Security, Reliability, Observability, CI/CD, Config Management, and Infrastructure domains. 13 implemented across 3 remediation batches. 4 deferred as low-risk or requiring ops coordination.

---

## Section 2: Inventory Summary

### 2.1 Repos Audited

| Repo | Role | Key Artifacts |
|---|---|---|
| `n8n/n8n` | Upstream application | TypeScript monorepo, 25+ packages, official Docker image |
| `n8n-self-hosting` | Helm chart + ArgoCD manifests | `helm/n8n-application/`, ArgoCD App of Apps |
| `homelab-infra` | Platform infrastructure | Vault policies/roles, ingress, monitoring stack, MicroK8s |

### 2.2 Upstream n8n (`n8n/n8n`)

| Attribute | Value |
|---|---|
| Language | TypeScript monorepo, 25+ packages |
| Docker image | `n8nio/n8n` (official) |
| Health endpoint | `/healthz` |
| Metrics endpoint | `/metrics` (requires `N8N_METRICS=true`) |
| Key env vars | `N8N_ENCRYPTION_KEY`, `N8N_WEBHOOK_URL`, `N8N_METRICS` |
| HA support | Queue mode (main + worker pods) |
| Default storage | SQLite; PostgreSQL supported |
| K8s artifacts | None — no upstream Helm chart or manifests |

### 2.3 n8n-self-hosting

| Attribute | Value |
|---|---|
| Helm chart | `helm/n8n-application/` |
| ArgoCD pattern | App of Apps (root → local + live child apps) |
| n8n image | `n8nio/n8n:1.19.4`, 1 replica main + 1 replica worker, RollingUpdate strategy |
| n8n queue mode | `EXECUTIONS_MODE=queue`, Redis-backed leader election, concurrency 10 |
| PostgreSQL image | `postgres:16-alpine`, 1 replica, StatefulSet (`n8n-application-postgres-0`) |
| Redis | `redis:7-alpine`, 1 replica, in-namespace ephemeral queue |
| Secrets | ESO `SecretStore` + `ExternalSecret` for postgres creds |
| Vault path | `kv/secret/n8n/live/postgres` (KV v2) |
| Health probes | Startup: 10s/10s/12 · Readiness: 15s/10s/3 · Liveness: 30s/30s/3 |
| Backup | CronJob daily 2AM, `pg_dump`, 30-day retention, 10Gi PVC |
| Observability | `ServiceMonitor` + `PrometheusRule` (7 alerts) + Grafana dashboard |
| Network policy | n8n: ingress from ingress+observability ns · postgres: ingress from n8n only |
| Resource controls | `ResourceQuota` + `LimitRange` |
| Pod disruption | `PDB` on postgres always; n8n only when replicas > 1 |
| Security posture | Read-only root FS, non-root user, seccomp, all capabilities dropped |
| CI | GitHub Actions → `kubectl apply` ArgoCD manifest (no Helm validation pre-fix) |
| Documentation | 9 docs; 4+ were stale at audit time |

### 2.4 homelab-infra

| Attribute | Value |
|---|---|
| Vault artifacts | `n8n-readonly` policy; `n8n-readonly` + `n8n-live` roles |
| Ingress | n8n manifest with TLS (`homelab-tls` wildcard) + nginx basic auth |
| Monitoring stack | Prometheus, Loki, Tempo, Alloy, Grafana |
| Alerting | Alertmanager → Telegram notifications |
| Node | MicroK8s single-node (Intel i5-7600, 32 GB RAM, Ubuntu 24.04) |
| Known platform bug | Calico hostNetwork issue causes DNS timeouts; mitigated by a patch CronJob |

---

## Section 3: Gap Analysis

### 3.1 Security

| ID | Severity | Gap | What Upstream Provides | Missing in Self-Hosting |
|---|---|---|---|---|
| GAP-002 | **CRITICAL** | No `N8N_ENCRYPTION_KEY` | Env var support for credential encryption | Key auto-generated on PVC; not persisted in Vault |
| GAP-003 | **CRITICAL** | Dual ingress conflict | N/A | Two Ingress resources for same host (`n8n.homelab.local`) |
| GAP-004 | **CRITICAL** | No `N8N_WEBHOOK_URL` | Env var for webhook callback URL | Not configured anywhere |
| GAP-005 | **HIGH** | App secrets not in Vault | N/A | Only postgres creds managed by ESO; app secrets unmanaged |
| GAP-009 | **HIGH** | `n8n-live` Vault role has no `max_ttl` | N/A | Indefinite token renewal possible without re-auth |

### 3.2 Reliability

| ID | Severity | Gap | Detail |
|---|---|---|---|
| GAP-001 | **CRITICAL** | `sleep 5` startup hack causes restart storm | 19 n8n restarts/7d, 39 postgres restarts/23d; CoreDNS not ready after Calico hostNetwork bug on node restart |
| GAP-007 | **HIGH** | Backups are on-cluster only | PVC failure = data loss; no off-cluster copy |
| GAP-012 | **MEDIUM** | Recreate strategy causes downtime during deploys | No rolling update; every deploy = full outage window |

### 3.3 Observability

| ID | Severity | Gap | Detail |
|---|---|---|---|
| GAP-006 | **HIGH** | No postgres metrics exporter | Postgres health opaque to Prometheus; no query latency, connection, or replication metrics |
| GAP-014 | **MEDIUM** | `ServiceMonitor` label `n8n-svn` is unconventional | Non-standard label may cause Prometheus operator selector mismatches |

### 3.4 CI/CD

| ID | Severity | Gap | Detail |
|---|---|---|---|
| GAP-010 | **MEDIUM** | No Helm lint or template validation in CI | Broken Helm templates reach the cluster; no pre-merge gate |

### 3.5 Config Management

| ID | Severity | Gap | Detail |
|---|---|---|---|
| GAP-008 | **HIGH** | 6+ stale entries in `VAULT_INTEGRATION.md`; 4 more stale docs | Wrong mount point, role names, SA names; stale paths in other docs |
| GAP-011 | **MEDIUM** | `protocol: https` set but TLS terminates at ingress | Causes internal plaintext traffic to be mislabeled; misleading config |
| GAP-013 | **MEDIUM** | No `values.schema.json` | No input validation on Helm values; silent misconfiguration risk |
| GAP-017 | **MEDIUM** | Resources 10–35x over-provisioned | n8n at 2.8% CPU, 27.5% memory utilization vs. configured limits |

### 3.6 Infrastructure

| ID | Severity | Gap | Detail |
|---|---|---|---|
| GAP-015 | **LOW** | Postgres deployed as `Deployment`, not `StatefulSet` | No stable network identity or ordinal pod naming; less idiomatic for stateful workloads |
| GAP-016 | **LOW** | No `NOTES.txt` in Helm chart | `helm install` produces no post-install guidance |

---

## Section 4: Prioritized Recommendations Backlog

### GAP-001 — Reliability · CRITICAL · P1 · Implemented

| Field | Value |
|---|---|
| Problem | `sleep 5; n8n start` as the container command is a timing hack, not a readiness gate |
| Why It Matters | When CoreDNS is slow (Calico hostNetwork bug on node restart), DNS resolution fails and n8n crashes. 19 restarts in 7 days = active SLA violation |
| Recommended Fix | Replace `sleep 5` with a `pg_isready` init container that polls postgres until ready, then starts n8n cleanly |
| Effort | Low |

### GAP-002 — Security · CRITICAL · P1 · Implemented

| Field | Value |
|---|---|
| Problem | No `N8N_ENCRYPTION_KEY` set; n8n generates one at startup and writes it to the PVC |
| Why It Matters | PVC replacement, migration, or disaster recovery will silently invalidate all stored credentials in n8n workflows |
| Recommended Fix | Extract key from running pod, store in Vault at `kv/secret/n8n/live/app`, inject via new `n8n-app-secret` ExternalSecret |
| Effort | Medium |

### GAP-003 — Security · CRITICAL · P1 · Implemented

| Field | Value |
|---|---|
| Problem | Helm chart and `homelab-infra` both create Ingress for `n8n.homelab.local` |
| Why It Matters | Duplicate Ingress resources cause unpredictable routing, potential unauthenticated access bypass, and nginx config conflicts |
| Recommended Fix | Disable Helm-managed ingress (`ingress.enabled: false` in `values-live.yaml`); `homelab-infra` owns the single authoritative Ingress |
| Effort | Low |

### GAP-004 — Security · CRITICAL · P1 · Implemented

| Field | Value |
|---|---|
| Problem | `N8N_WEBHOOK_URL` not configured |
| Why It Matters | n8n constructs webhook callback URLs from the pod's internal hostname. External services receive an unreachable URL; webhooks silently fail |
| Recommended Fix | Set `N8N_WEBHOOK_URL=https://n8n.homelab.local` via `n8n-app-secret` ExternalSecret, sourced from Vault |
| Effort | Low |

### GAP-005 — Security · HIGH · P1 · Implemented

| Field | Value |
|---|---|
| Problem | Only postgres credentials are managed by ESO. n8n application secrets (encryption key, webhook URL) are unmanaged |
| Why It Matters | Secrets outside Vault have no rotation lifecycle, audit log, or break-glass revocation path |
| Recommended Fix | Create Vault path `kv/secret/n8n/live/app`, add `n8n-app-secret` ExternalSecret, inject into n8n Deployment |
| Effort | Medium |

### GAP-006 — Observability · HIGH · P1 · Implemented

| Field | Value |
|---|---|
| Problem | No `postgres_exporter` sidecar; postgres metrics absent from Prometheus |
| Why It Matters | Cannot alert on connection saturation, query latency, or replication lag. Postgres failures are invisible until n8n itself fails |
| Recommended Fix | Add `postgres-exporter` sidecar to postgres Deployment; expose port 9187; add ServiceMonitor endpoint; add 4 PrometheusRule alerts |
| Effort | Medium |

### GAP-007 — Reliability · HIGH · P2 · Implemented (2026-04-08)

| Field | Value |
|---|---|
| Problem | Backup CronJob writes only to an in-cluster PVC |
| Why It Matters | Node failure, storage class failure, or accidental PVC deletion destroys all backups alongside the primary data |
| Fix Applied | Added `rclone/rclone:1.68` off-cluster upload step to CronJob. When `backup.offCluster.enabled: true`: pg-backup runs as init container (pg_dump → PVC + writes `.latest-backup`), rclone-upload runs as main container (copies to S3-compatible target via env-var config). ExternalSecret pulls credentials from Vault at `kv/secret/n8n/live/backup-offcluster`. Feature-flagged off by default — enable once credentials are in Vault. |
| Effort | Medium |
| Activation | Set `backup.offCluster.enabled: true`, `endpoint`, `bucket` in values-live.yaml after populating Vault path. |

### GAP-008 — Config Management · HIGH · P1 · Implemented

| Field | Value |
|---|---|
| Problem | `VAULT_INTEGRATION.md` has 6+ factual errors; 4 additional docs reference stale paths and components |
| Why It Matters | Runbook errors during an incident cause operators to execute wrong commands against a production cluster |
| Recommended Fix | Correct all errors in `VAULT_INTEGRATION.md` (mount point, role names, SA names); update 4 other docs to current chart paths and components |
| Effort | Low |

### GAP-009 — Security · HIGH · P1 · Implemented

| Field | Value |
|---|---|
| Problem | `n8n-live` Vault role has no `max_ttl` configured |
| Why It Matters | ESO can renew tokens indefinitely without re-authenticating; compromised token has no forced expiry |
| Recommended Fix | Set `max_ttl: 24h` in `homelab-infra/apps/vault/config/roles/n8n-live.json` and re-run bootstrap script |
| Effort | Low |

### GAP-010 — CI/CD · MEDIUM · P2 · Implemented

| Field | Value |
|---|---|
| Problem | GitHub Actions workflow applies ArgoCD manifest without validating the Helm chart |
| Why It Matters | A template syntax error or invalid values merge reaches the cluster and causes a failed ArgoCD sync |
| Recommended Fix | Add `validate` job to `.github/workflows/deploy.yaml` running `helm lint` and `helm template` before any apply |
| Effort | Low |

### GAP-011 — Config Management · MEDIUM · P2 · Implemented

| Field | Value |
|---|---|
| Problem | `protocol: https` set in values but TLS terminates at the nginx ingress controller |
| Why It Matters | Misleads operators into believing pod-to-pod traffic is encrypted; may cause misconfiguration in future TLS-passthrough changes |
| Recommended Fix | Set `protocol: http` in `values-live.yaml` to reflect actual internal traffic model |
| Effort | Low |

### GAP-012 — Reliability · MEDIUM · P3 · Implemented (2026-04-08)

| Field | Value |
|---|---|
| Problem | `strategy: Recreate` means every deployment tears down the old pod before the new one starts |
| Why It Matters | Planned deployments cause a guaranteed outage window. Acceptable for single-replica homelab, but increases MTTR |
| Fix Applied | Enabled n8n queue mode (`EXECUTIONS_MODE=queue`). Added dedicated Redis Deployment (`redis:7-alpine`, ephemeral, no persistence). Added worker Deployment (`n8n worker`, RollingUpdate, concurrency 10, health check on port 5679). Main switched from `Recreate` → `RollingUpdate` (`maxSurge: 1, maxUnavailable: 0`). Redis leader election prevents dual-scheduler overlap during rolling window. NetworkPolicy extended for worker→postgres and worker→Redis. Worker uses `emptyDir` for `/home/node/.n8n` (n8n writes config on startup regardless of mode). |
| Effort | High |

### GAP-013 — Config Management · MEDIUM · P2 · Implemented

| Field | Value |
|---|---|
| Problem | No `values.schema.json` in the Helm chart |
| Why It Matters | Helm does not validate values types or required fields at `helm install`/`upgrade` time; silent misconfiguration |
| Recommended Fix | Author `helm/n8n-application/values.schema.json` covering all top-level values with types, required fields, and descriptions |
| Effort | Medium |

### GAP-014 — Observability · MEDIUM · P2 · Implemented

| Field | Value |
|---|---|
| Problem | `ServiceMonitor` uses label `n8n-svn` which is non-standard and unconventional |
| Why It Matters | Prometheus operator label selectors may not match; metrics scraping silently stops if selector is misconfigured |
| Recommended Fix | Normalize label to `app.kubernetes.io/name: n8n` to align with standard Prometheus operator conventions |
| Effort | Low |

### GAP-015 — Infrastructure · LOW · P3 · Implemented (2026-04-08)

| Field | Value |
|---|---|
| Problem | Postgres runs as a `Deployment`, not a `StatefulSet` |
| Why It Matters | No stable network identity or ordinal naming; less idiomatic for stateful workloads; ordering guarantees absent |
| Fix Applied | Converted postgres Deployment to StatefulSet (`podManagementPolicy: OrderedReady`, `updateStrategy: RollingUpdate`). Added headless service `postgres-headless` (ClusterIP: None) for StatefulSet `serviceName` DNS. Pod is now `n8n-application-postgres-0` (stable identity). PVC still referenced via `volumes` to avoid data migration of existing `n8n-application-postgres-pvc`; noted for future `volumeClaimTemplates` adoption. |
| Effort | Medium |
| Note | On single-node microk8s with hostpath storage, Deployment→StatefulSet migration must scale the Deployment to 0 first. ArgoCD left both running briefly; WAL recovery handled the unclean shutdown cleanly. |

### GAP-016 — Infrastructure · LOW · P3 · Deferred

| Field | Value |
|---|---|
| Problem | No `helm/n8n-application/templates/NOTES.txt` |
| Why It Matters | `helm install` output is blank; operators get no post-install verification steps or URLs |
| Recommended Fix | Add `NOTES.txt` with access URL, ESO sync check command, and first-login note |
| Effort | Low |

### GAP-017 — Config Management · MEDIUM · P3 · Implemented (2026-04-08)

| Field | Value |
|---|---|
| Problem | Configured resource limits are 10–35x above observed utilization (n8n: 2.8% CPU, 27.5% memory) |
| Why It Matters | Over-provisioning wastes node capacity and inflates `ResourceQuota` headroom, potentially blocking other workloads on a single-node cluster |
| Fix Applied | Right-sized after 7-day post-fix baseline (actual: n8n 9m CPU/142Mi RAM, postgres 26m CPU/38Mi RAM). Reduced requests by 73% CPU and 50% RAM across all containers. Memory limits unchanged — n8n limit kept at 1Gi to cover `NODE_OPTIONS --max-old-space-size=768`. n8n: 50m/500m CPU, 256Mi/1Gi RAM. postgres: 50m/250m CPU, 128Mi/512Mi RAM. exporter: 50m/100m CPU, 32Mi/64Mi RAM. Note: LimitRange enforces `min.cpu=50m` — exporter was initially set to 20m and blocked pod creation. |
| Effort | Low |

---

## Section 5: Implementation Artifacts Reference

### Batch 1 — Critical Stability and Security

| File | Change |
|---|---|
| `helm/n8n-application/templates/n8n-deployment.yaml` | Added `pg_isready` init container replacing `sleep 5`; added `N8N_ENCRYPTION_KEY` and `N8N_WEBHOOK_URL` env vars sourced from `n8n-app-secret` |
| `helm/n8n-application/templates/external-secret.yaml` | Added `n8n-app-secret` ExternalSecret targeting `kv/secret/n8n/live/app` in Vault |
| `helm/n8n-application/values-live.yaml` | Set `ingress.enabled: false`, `protocol: http`, added `appSecretPath` and `webhookUrl` values |
| `homelab-infra/apps/vault/config/roles/n8n-live.json` | Added `max_ttl: 24h` |

### Batch 2 — Observability

| File | Change |
|---|---|
| `helm/n8n-application/templates/postgres-deployment.yaml` | Added `postgres-exporter` sidecar container |
| `helm/n8n-application/templates/postgres-service.yaml` | Added metrics port 9187; normalized labels |
| `helm/n8n-application/templates/servicemonitor.yaml` | Added postgres exporter endpoint; fixed label to `app.kubernetes.io/name: n8n` |
| `helm/n8n-application/templates/network-policy.yaml` | Added allow rule for observability namespace on port 9187 |
| `helm/n8n-application/templates/prometheus-rules.yaml` | Added 4 postgres alerts (connection saturation, query latency, exporter down, replication lag) |
| `helm/n8n-application/templates/n8n-service.yaml` | Normalized labels to align with ServiceMonitor selector |

### Batch 3 — Documentation, CI, and Schema

| File | Change |
|---|---|
| `docs/VAULT_INTEGRATION.md` | 8 corrections: mount point, role names, SA names, policy paths |
| `docs/NETWORK_EXPOSURE_GUIDE.md` | Updated Kong references → nginx |
| `docs/DATABASE_COMPATIBILITY_FIX.md` | Updated to unified chart paths |
| `docs/DATABASE_PERMISSIONS_FIX.md` | Updated postgres user references |
| `docs/POSTGRESQL_DEPLOYMENT_GUIDE.md` | Updated StatefulSet guidance → Deployment; noted GAP-015 deferral |
| `docs/POSTGRES_FIX_SUMMARY.md` | Updated all chart paths |
| `.github/workflows/deploy.yaml` | Added `validate` job running `helm lint` + `helm template` |
| `helm/n8n-application/values.schema.json` | New file: JSON Schema for all top-level Helm values |

### Batch 4 — Deferred Gap Closure (2026-04-08)

| File | Change |
|---|---|
| `helm/n8n-application/values-live.yaml` | GAP-017: Reduced requests 73% CPU / 50% RAM based on 7-day baseline. GAP-012: Added `queue` block (`enabled: true`, Redis config, worker replicas + resources). |
| `helm/n8n-application/templates/postgres-deployment.yaml` | GAP-015: Converted Deployment → StatefulSet (`serviceName: postgres-headless`, `OrderedReady`, `RollingUpdate`). Removed `restartPolicy: Always` (invalid on StatefulSet). |
| `helm/n8n-application/templates/postgres-service.yaml` | GAP-015: Added headless service `postgres-headless` (ClusterIP: None) for StatefulSet DNS. |
| `helm/n8n-application/templates/redis-deployment.yaml` | GAP-012: New. Redis 7-alpine Deployment, no persistence (`--save "" --appendonly no`), ephemeral job queue only. |
| `helm/n8n-application/templates/redis-service.yaml` | GAP-012: New. ClusterIP service for Redis on port 6379. |
| `helm/n8n-application/templates/n8n-worker-deployment.yaml` | GAP-012: New. Worker Deployment (`n8n worker`, RollingUpdate, `maxSurge:1`, 120s grace period, health check port 5679, emptyDir at `/home/node/.n8n`). |
| `helm/n8n-application/templates/n8n-deployment.yaml` | GAP-012: Conditional `RollingUpdate` strategy when `queue.enabled`. Added `wait-for-redis` init container. Added `EXECUTIONS_MODE`, `QUEUE_BULL_REDIS_HOST/PORT`, `N8N_SKIP_WEBHOOK_DEREGISTRATION_SHUTDOWN` env vars. |
| `helm/n8n-application/templates/network-policy.yaml` | GAP-012: Added Redis ingress NP (from n8n + worker). Added worker NP (egress to postgres, redis, DNS, HTTPS). Added Redis egress to n8n main NP. Added worker podSelector to postgres ingress NP. |

---

## Section 6: Post-Implementation Checklist

### Pre-Flight (Manual — Required Before First Deploy)

- [ ] **Extract existing encryption key** from the running pod to prevent credential loss:
  ```bash
  kubectl exec -n n8n-live <pod> -c n8n -- cat /home/node/.n8n/config
  ```
- [ ] **Store extracted key in Vault** (never commit to git):
  ```bash
  vault kv put kv/secret/n8n/live/app \
    N8N_ENCRYPTION_KEY=<extracted-key> \
    N8N_WEBHOOK_URL=https://n8n.homelab.local
  ```
- [ ] **Re-run Vault bootstrap** to apply `max_ttl` to the `n8n-live` role:
  ```bash
  bash apps/vault/scripts/bootstrap-vault.sh
  ```

### Post-Deployment Validation

- [ ] **ESO sync:** Both `n8n-postgres-secret` and `n8n-app-secret` ExternalSecrets show `STATUS: SecretSynced`
  ```bash
  kubectl get externalsecret -n n8n-live
  ```
- [ ] **Init container:** `wait-for-postgres` init container exits 0 (not in crashloop)
  ```bash
  kubectl logs -n n8n-live <pod> -c wait-for-postgres
  ```
- [ ] **Pod stability:** Pod is running with 0 restarts in the first hour post-deploy
  ```bash
  kubectl get pod -n n8n-live -w
  ```
- [ ] **Encryption smoke test:** Open n8n UI → existing workflows with stored credentials execute successfully (validates key continuity)
- [ ] **7-day stability target:** Restart count < 2 over 7 days (baseline was 19/7d)
  ```bash
  kubectl get pod -n n8n-live -o jsonpath='{.items[*].status.containerStatuses[*].restartCount}'
  ```
- [ ] **Postgres metrics scraping:** Prometheus is scraping `postgres-exporter` metrics
  ```
  Prometheus UI → Targets → n8n-live/postgres-exporter: UP
  ```
- [ ] **Grafana dashboard:** Postgres panels populate (connection count, query latency, exporter status)
- [ ] **CI validate job:** `helm lint` and `helm template` jobs pass on the next PR targeting `main`
