# n8n Production Readiness Checklist

## Pre-Deployment

- [ ] **[ACTION REQUIRED]** Replace `n8n.local` with actual domain in `values-live.yaml` (ingress.hosts and ingress.tls)
- [ ] **[ACTION REQUIRED]** Store PostgreSQL credentials in Vault at `secret/n8n/live/postgres` with keys: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_NON_ROOT_USER`, `POSTGRES_NON_ROOT_PASSWORD`
- [ ] **[ACTION REQUIRED]** Create Vault policy and Kubernetes auth role per `docs/VAULT_INTEGRATION.md`
- [ ] **[ACTION REQUIRED]** Ensure External Secrets Operator is installed: `helm install external-secrets external-secrets/external-secrets -n external-secrets --create-namespace`
- [ ] **[ACTION REQUIRED]** Ensure cert-manager is installed with a `letsencrypt-prod` ClusterIssuer
- [ ] **[ACTION REQUIRED]** Enable MicroK8s addons: `microk8s enable dns ingress storage observability`
- [ ] **[ACTION REQUIRED]** Verify the `monitoring.additionalLabels.release` value matches your Prometheus Operator release name
- [ ] **[ACTION REQUIRED]** If Grafana is in a different namespace, set `monitoring.grafanaDashboard.namespace` to that namespace

## Security Hardening (Pillar 1) — Completed

- [x] `securityContext` applied from values on n8n pod (non-root, drop ALL caps, readOnlyRootFilesystem)
- [x] `seccompProfile: RuntimeDefault` on all pods (n8n + postgres)
- [x] `automountServiceAccountToken: false` on all pods
- [x] NetworkPolicy template created — restricts postgres to n8n-only ingress, n8n to ingress-controller-only
- [x] Egress restricted: DNS (53), PostgreSQL (5432), HTTP/HTTPS (80/443) only
- [x] Init container has explicit resource limits
- [x] Ingress security headers added (X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, Referrer-Policy)
- [x] TLS enforced via `ssl-redirect` and `force-ssl-redirect` annotations
- [x] Rate limiting configured (10 req/sec via `limit-rps`)
- [x] Inline secrets only used for LOCAL dev; LIVE uses Vault + ESO

## Memory & OOM Prevention (Pillar 2) — Completed

- [x] n8n resources: 250m/512Mi requests, 1000m/1Gi limits
- [x] PostgreSQL resources: 250m/256Mi requests, 500m/512Mi limits (was missing CPU limit)
- [x] `NODE_OPTIONS=--max-old-space-size=768` for Node.js heap cap
- [x] `EXECUTIONS_DATA_PRUNE=true` with 7-day max age (168 hours)
- [x] `EXECUTIONS_DATA_PRUNE_MAX_COUNT=50000` cap
- [x] `LimitRange` created — default container limits with namespace-wide max
- [x] `ResourceQuota` created — caps namespace to 4 CPU / 4Gi memory / 10 pods

## Self-Healing & Auto-Restart (Pillar 3) — Completed

- [x] n8n `livenessProbe` on `/healthz` (30s initial delay, 30s period)
- [x] n8n `readinessProbe` on `/healthz` (15s initial delay, 10s period)
- [x] n8n `startupProbe` on `/healthz` (allows 120s startup window before liveness kicks in)
- [x] PostgreSQL readiness/liveness probes via `pg_isready` (already existed, kept)
- [x] `PodDisruptionBudget` for PostgreSQL (minAvailable: 1)
- [x] n8n PDB conditionally created when replicas > 1
- [x] `restartPolicy: Always` on all deployments

## Logging, Monitoring & Alerting (Pillar 4) — Completed

- [x] Structured logging: `N8N_LOG_OUTPUT=console,file`, `N8N_LOG_LEVEL=info`
- [x] Telemetry disabled: `N8N_DIAGNOSTICS_ENABLED=false`
- [x] `ServiceMonitor` created for Prometheus scraping (port 5678, /metrics)
- [x] `PrometheusRule` created with 7 alert rules:
  - `N8nOOMKilled` (critical) — container was OOMKilled
  - `N8nCrashLooping` (critical) — 3+ restarts in 15 minutes
  - `N8nPodNotReady` (warning) — pod not ready for 5+ minutes
  - `N8nHighMemoryUsage` (warning) — memory usage above 85% of limit
  - `PostgresNotReady` (critical) — postgres pod not ready for 3+ minutes
  - `PostgresPVCNearlyFull` (warning) — PVC usage above 80%
  - `N8nBackupFailed` (warning) — backup CronJob failed
- [x] Grafana dashboard ConfigMap created (auto-provisioned via `grafana_dashboard: "1"` label)
  - Pod status, restart count, memory/CPU time series, PVC usage gauge

## Robustness & Data Integrity (Pillar 5) — Completed

- [x] PostgreSQL image now sourced from values (`postgres:16-alpine`) instead of hardcoded `postgres:11`
- [x] PVC sizes now sourced from values (was hardcoded 2Gi/10Gi, now 5Gi/20Gi for LIVE)
- [x] n8n image pinned to `1.19.4` (verified, no `:latest`)
- [x] Backup CronJob created: daily at 2 AM, `pg_dump` with gzip compression
- [x] Backup retention: 30-day auto-prune
- [x] Backup PVC: 10Gi dedicated storage
- [x] `/tmp` emptyDir mounted when `readOnlyRootFilesystem: true` (prevents crash on temp file writes)
- [x] Deployment strategy: `Recreate` for n8n (correct for single-replica with PVC)

## Post-Deployment Verification

- [ ] Verify n8n pod is `Running` and `Ready`: `kubectl get pods -n n8n-live`
- [ ] Verify PostgreSQL pod is `Running` and `Ready`
- [ ] Verify n8n health endpoint: `kubectl exec -n n8n-live deploy/n8n -- wget -qO- http://localhost:5678/healthz`
- [ ] Verify Ingress and TLS: `curl -I https://<your-domain>`
- [ ] Verify NetworkPolicy blocks unauthorized traffic
- [ ] Verify ExternalSecret is synced: `kubectl get externalsecret -n n8n-live`
- [ ] Verify ServiceMonitor is discovered: check Prometheus targets page
- [ ] Verify Grafana dashboard loads under "n8n Self-Hosted"
- [ ] Verify backup CronJob: `kubectl get cronjob -n n8n-live`
- [ ] Run a test workflow in n8n to confirm end-to-end functionality
