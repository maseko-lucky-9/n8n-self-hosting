# n8n MicroK8s Operations Runbook

> **`n8n-live` is deployed only by ArgoCD** (Application `n8n-live`, manual sync, tracks `main`). Merging a PR deploys nothing until you sync — see §4.
> **Never run Helm against it.** There is no Helm release there any more, and `scripts/deploy.sh live` now refuses. Upgrades follow §13.

## Quick Reference

| Action | Command |
|---|---|
| Check all pods | `sudo microk8s kubectl get pods -n n8n-live` |
| Check n8n logs | `sudo microk8s kubectl logs -n n8n-live deploy/n8n -f` |
| Check postgres logs | `sudo microk8s kubectl logs -n n8n-live n8n-application-postgres-0 -c postgres -f` |
| Check worker logs | `sudo microk8s kubectl logs -n n8n-live -l service=n8n-worker -c n8n-worker -f` |
| Check Redis logs | `sudo microk8s kubectl logs -n n8n-live -l app.kubernetes.io/component=redis -f` |
| Describe n8n pod | `sudo microk8s kubectl describe pod -n n8n-live -l service=n8n` |
| Check events | `sudo microk8s kubectl get events -n n8n-live --sort-by='.lastTimestamp'` |
| Check PVC usage | `sudo microk8s kubectl exec -n n8n-live deploy/n8n -- df -h /home/node/.n8n` |

---

## 1. Restart n8n

**When:** After config changes, OOM recovery, or unresponsive UI.

```bash
# Rolling restart (zero-downtime if multiple replicas)
sudo microk8s kubectl rollout restart deployment/n8n -n n8n-live

# Watch rollout status
sudo microk8s kubectl rollout status deployment/n8n -n n8n-live --timeout=120s
```

**If pod is stuck:**
```bash
# Force delete stuck pod
sudo microk8s kubectl delete pod -n n8n-live -l service=n8n --grace-period=30

# If still stuck (last resort)
sudo microk8s kubectl delete pod -n n8n-live -l service=n8n --force --grace-period=0
```

---

## 2. Restart PostgreSQL

**When:** Database connectivity issues, after Vault secret rotation.

```bash
# Restart postgres StatefulSet (pod will be n8n-application-postgres-0)
sudo microk8s kubectl rollout restart statefulset/n8n-application-postgres -n n8n-live

# IMPORTANT: Restart n8n main + workers AFTER postgres is ready
sudo microk8s kubectl wait --for=condition=ready pod -n n8n-live -l app.kubernetes.io/component=postgres --timeout=120s
sudo microk8s kubectl rollout restart deployment/n8n -n n8n-live
sudo microk8s kubectl rollout restart deployment/n8n-application-worker -n n8n-live
```

---

## 3. Scale n8n

**When:** Increasing capacity (workers) or shutting down for maintenance.

```bash
# Scale workers up (safe — workers are stateless, pick jobs from Redis queue)
sudo microk8s kubectl scale deployment/n8n-application-worker -n n8n-live --replicas=2

# Scale workers down. n8n exits after its own 30 s graceful-shutdown default
# (N8N_GRACEFUL_SHUTDOWN_TIMEOUT); terminationGracePeriodSeconds=120 does not extend it.
# For a clean stop, drain the queue first (see §13 step 7).
sudo microk8s kubectl scale deployment/n8n-application-worker -n n8n-live --replicas=1

# Maintenance shutdown (scale main + workers to 0, keep postgres running)
sudo microk8s kubectl scale deployment/n8n -n n8n-live --replicas=0
sudo microk8s kubectl scale deployment/n8n-application-worker -n n8n-live --replicas=0

# Restore
sudo microk8s kubectl scale deployment/n8n -n n8n-live --replicas=1
sudo microk8s kubectl scale deployment/n8n-application-worker -n n8n-live --replicas=1
```

> **Note:** Main (`deployment/n8n`) is the webhook/scheduler process — keep at 1 replica. Workers (`deployment/n8n-application-worker`) are safe to scale horizontally; queue mode is active.

---

## 4. Deploy, Sync & Roll Back

**`n8n-live` is managed by ArgoCD** (Application `n8n-live`, manual sync, tracks `main`). Merging a PR deploys nothing until you sync.

> **Do not use Helm or `rollout undo` on `n8n-live`.**
> There is no Helm release for `n8n-live`. A stale record (last written 2026-04-07, n8n 1.19.4) listed both data PVCs, so `helm uninstall` would have deleted the
> database and the n8n data dir. It was removed on 2026-09-20; `helm list -n n8n-live` is empty and `helm rollback`/`uninstall` now exit "release: not found".
> - **If `helm list -n n8n-live` ever shows a release again, stop and investigate** — something ran Helm against live, and a later `uninstall` would target live data.
> - `helm upgrade`/`install` (including `scripts/deploy.sh live`, which now refuses) aborts on ownership conflicts, because resources ArgoCD created carry no Helm metadata.
> - `kubectl rollout undo` isn't reverted by ArgoCD (no selfHeal), so live silently drifts from git. After a version upgrade it also runs old code against a migrated schema.
>
> The three data PVs are reclaim `Retain` (set 2026-09-20), so deleting a PVC no longer destroys the data — but the PV is left `Released` and needs manual re-binding.

### Sync (after a PR is merged)
The `argocd` CLI on the node is not logged in. Patching `.operation` does the same thing as `argocd app sync`.
```bash
SHA=<merge commit SHA on main>
sudo microk8s kubectl -n argocd patch application n8n-live --type merge \
  -p "{\"operation\":{\"initiatedBy\":{\"username\":\"$USER\"},\"sync\":{\"revision\":\"$SHA\"}}}"

# One resource only: add this inside "sync":
#   ,"resources":[{"group":"apps","kind":"Deployment","name":"n8n","namespace":"n8n-live"}]

# BEFORE patching: phase must not be "Running", or you'll queue onto someone else's sync.
# AFTER: syncResult.revision must equal $SHA and finishedAt must be later than your patch —
# "Synced/Healthy" alone can be left over from an earlier sync.
sudo microk8s kubectl -n argocd get application n8n-live -o jsonpath='{.status.operationState.phase}
{.status.operationState.syncResult.revision}
{.status.operationState.finishedAt}
{.status.sync.status} {.status.health.status}{"\n"}'
```
A plain full sync is fine for config-only changes. **An n8n version change must follow §13.**

### Roll back a config change (same n8n version)
`git revert <sha>` → PR → merge → Sync (above).

### Roll back an n8n version upgrade
The migrations only run forward (`n8n db:revert` undoes one migration per run, which is impractical across ~100), so the database goes back with the image.
This needs the `n8n_pre_<ver>` copy taken in §13. Without it, the pre-upgrade dump is the only route — but **§9's restore does not work as written** (see the warning there).

> **The copy is a point in time.** Everything written after it is lost: executions, workflow edits, new credentials. Export anything you need first.

```bash
K="sudo microk8s kubectl -n n8n-live"
PSQL="$K exec -i n8n-application-postgres-0 -c postgres -- psql -U postgres -d postgres -v ON_ERROR_STOP=1"

# 0. FIRST: git revert the upgrade PR and merge it, so main is back on the old version.
#    Syncing an old SHA while the app tracks HEAD leaves it OutOfSync, and the obvious
#    "fix" (sync) would redeploy the new version onto the restored database.

# 1. Stop main, let the worker drain, then stop the worker.
#    Jobs enqueued by the new version must not reach the old one.
$K scale deploy/n8n --replicas=0
$K exec deploy/n8n-application-redis -- sh -c \
  'for q in active wait paused; do redis-cli llen bull:jobs:$q; done; redis-cli zcard bull:jobs:delayed'   # all must be 0
$K scale deploy/n8n-application-worker --replicas=0

# 2. Swap the databases. Run this from db "postgres": the postgres-exporter sidecar keeps a session
#    open on "n8n", and a database with open sessions can't be renamed.
#    CREATE DATABASE ... TEMPLATE doesn't copy database-level GRANTs; the GRANTs below restore
#    the original ACL (n8n_app=CTc, n8n_live=CTc, n8n_watchdog=c).
$PSQL <<'SQL'
ALTER DATABASE n8n ALLOW_CONNECTIONS false;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'n8n' AND pid <> pg_backend_pid();
ALTER DATABASE n8n RENAME TO n8n_failed_<ver>;
ALTER DATABASE n8n_pre_<ver> RENAME TO n8n;
GRANT CONNECT, TEMPORARY, CREATE ON DATABASE n8n TO n8n_app, n8n_live;
GRANT CONNECT ON DATABASE n8n TO n8n_watchdog;
SQL

# 3. Sync HEAD (the revert commit from step 0). This restores the old image and replicas: 1.
# 4. Verify: both pods on the old digest, readiness 200, published workflows and webhook_entity
#    match the pre-upgrade baseline.
```
The SQL above was rehearsed on scratch databases on 2026-09-19 (copy, rename, re-GRANT, data intact).
The full rollback — n8n booting on the restored database, and the ArgoCD step — has **not** been drilled.

---

## 5. Debug Pod Startup Failures

```bash
# 1. Check pod status and events
sudo microk8s kubectl describe pod -n n8n-live -l service=n8n

# 2. Check init container logs (volume permissions)
sudo microk8s kubectl logs -n n8n-live -l service=n8n -c volume-permissions

# 3. Check n8n container logs
sudo microk8s kubectl logs -n n8n-live deploy/n8n --previous  # Previous crash logs

# 4. Check if secrets exist
sudo microk8s kubectl get secret postgres-secret -n n8n-live -o yaml

# 5. Check ExternalSecret sync status
sudo microk8s kubectl get externalsecret -n n8n-live
sudo microk8s kubectl describe externalsecret postgres-external-secret -n n8n-live
```

---

## 6. Database Connectivity Issues

```bash
# 1. Verify postgres is running
sudo microk8s kubectl get pod -n n8n-live -l app.kubernetes.io/component=postgres

# 2. Test connectivity from n8n pod
sudo microk8s kubectl exec -n n8n-live deploy/n8n -- sh -c \
  "nc -zv postgres-service 5432 2>&1"

# 3. Check postgres readiness probe
sudo microk8s kubectl describe pod -n n8n-live -l app.kubernetes.io/component=postgres | grep -A5 "Readiness"

# 4. Connect to postgres directly
sudo microk8s kubectl exec -it -n n8n-live deploy/n8n-application-postgres -- \
  psql -U postgres -d n8n -c "SELECT 1;"

# 5. Check DNS resolution
sudo microk8s kubectl exec -n n8n-live deploy/n8n -- sh -c \
  "nslookup postgres-service"
```

---

## 7. OOM (Out of Memory) Recovery

**Symptoms:** Pod in `OOMKilled` state, `N8nOOMKilled` alert firing.

```bash
# 1. Confirm OOM
sudo microk8s kubectl get pod -n n8n-live -l service=n8n -o jsonpath='{.items[*].status.containerStatuses[*].lastState.terminated.reason}'

# 2. Check current memory usage
sudo microk8s kubectl top pod -n n8n-live

# 3. Short-term: Restart (K8s does this automatically)
sudo microk8s kubectl rollout restart deployment/n8n -n n8n-live

# 4. Long-term: Increase limits via values-live.yaml
#    - Increase resources.limits.memory (e.g., 1Gi → 1.5Gi)
#    - Increase NODE_OPTIONS --max-old-space-size (e.g., 768 → 1024)
#    - Reduce EXECUTIONS_DATA_MAX_AGE (e.g., 168 → 72)
#    Then: PR the values change, merge, and sync (§4). Never helm upgrade.
```

---

## 8. TLS Certificate Issues

```bash
# 1. Check certificate status
sudo microk8s kubectl get certificate -n n8n-live
sudo microk8s kubectl describe certificate n8n-live-tls -n n8n-live

# 2. Check cert-manager logs
sudo microk8s kubectl logs -n cert-manager deploy/cert-manager -f

# 3. Check ClusterIssuer
sudo microk8s kubectl describe clusterissuer letsencrypt-prod

# 4. Force certificate renewal
sudo microk8s kubectl delete secret n8n-live-tls -n n8n-live
# cert-manager will automatically re-issue
```

---

## 9. Backup & Restore

> **The restore steps below do not work as written — do not follow them in an incident.** Verified 2026-09-20:
> `/backups` is not mounted in the postgres pod (the StatefulSet mounts only its data volume), so step 3 fails immediately.
> The dump also carries no ownership, so restoring it as `postgres` leaves every table owned by `postgres` while the app connects as `n8n_app`.
> A working restore needs a Job that mounts the backup PVC and loads the dump **as `n8n_app`**, ideally into a fresh database first. Write and drill that before relying on it.
> The `n8n_pre_<ver>` database copy in §13 is the tested rollback path.

### Check Backup Status
```bash
# List backup jobs
sudo microk8s kubectl get cronjob -n n8n-live
sudo microk8s kubectl get jobs -n n8n-live -l app.kubernetes.io/component=backup

# Check last backup log
sudo microk8s kubectl logs -n n8n-live job/$(sudo microk8s kubectl get jobs -n n8n-live -l app.kubernetes.io/component=backup --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}')
```

### Trigger Manual Backup
```bash
sudo microk8s kubectl create job --from=cronjob/n8n-application-db-backup manual-backup-$(date +%s) -n n8n-live
```

### Restore from Backup
```bash
# 1. Scale down n8n main + workers to prevent writes
sudo microk8s kubectl scale deployment/n8n deployment/n8n-application-worker -n n8n-live --replicas=0

# 2. List available backups
sudo microk8s kubectl exec -n n8n-live n8n-application-postgres-0 -c postgres -- ls -lh /backups/

# 3. Restore (backup PVC must be mounted on postgres pod — it is by default via the CronJob SA)
BACKUP_FILE="n8n_db_20260315_020000.sql.gz"  # Replace with actual filename
sudo microk8s kubectl exec -it -n n8n-live n8n-application-postgres-0 -c postgres -- sh -c \
  "gunzip -c /backups/${BACKUP_FILE} | psql -U postgres -d n8n"

# 4. Scale n8n back up
sudo microk8s kubectl scale deployment/n8n deployment/n8n-application-worker -n n8n-live --replicas=1
```

> **Note:** Postgres is now a StatefulSet — the pod name is always `n8n-application-postgres-0`. For production restore, create a temporary Job with both the backup PVC and postgres credentials mounted.

---

## 10. Queue Mode Operations

### Check Queue Health
```bash
# Verify all queue components are running
sudo microk8s kubectl get pods -n n8n-live

# Check worker is connected to queue (should show "n8n worker is now ready")
sudo microk8s kubectl logs -n n8n-live -l service=n8n-worker -c n8n-worker --tail=5

# Check Redis is healthy
sudo microk8s kubectl exec -n n8n-live -l app.kubernetes.io/component=redis -- redis-cli ping
# Expected: PONG

# Check pending jobs in queue
sudo microk8s kubectl exec -n n8n-live -l app.kubernetes.io/component=redis -- \
  redis-cli llen bull:jobs:wait
```

### Restart Worker (zero-downtime)
```bash
# RollingUpdate: new worker starts before old is terminated
sudo microk8s kubectl rollout restart deployment/n8n-application-worker -n n8n-live
sudo microk8s kubectl rollout status deployment/n8n-application-worker -n n8n-live --timeout=120s
```

### Redis Recovery (queue data is ephemeral)
```bash
# If Redis crashes, in-flight jobs are lost but will be retried on next trigger.
# Redis will restart automatically via Deployment controller.
# Monitor worker logs after Redis recovers:
sudo microk8s kubectl logs -n n8n-live -l service=n8n-worker -c n8n-worker -f
```

---

## 11. Vault Secret Rotation

> **The values below are wrong for this instance — do not run them as written.** Verified 2026-09-20: the live secret carries
> `POSTGRES_USER=n8n_live` and `POSTGRES_NON_ROOT_USER=n8n_app`, and `n8n_app` owns every table. Writing the values shown here points n8n at the wrong role.
> Changing a password in Vault also does nothing on its own: Postgres keeps the old one until an `ALTER ROLE ... PASSWORD` runs, so the pods then fail SCRAM auth.
> A correct procedure (ALTER ROLE first, then `vault kv patch` the matching key, then force ESO sync and restart) still needs to be written and drilled.

```bash
# 1. Update secret in Vault.
#    -c vault: the pod runs more than one container.
#    VAULT_SKIP_VERIFY: VAULT_ADDR is https://127.0.0.1:8200 with a self-signed cert and
#    no VAULT_CACERT, so without it every command exits 2 with x509 unknown authority.
#    The path is kv/secret/... -- `secret/...` alone omits the mount and 404s.
#    There is no `vault` binary on the Mac or the host; it exists only in the pod.
microk8s kubectl -n vault exec vault-0 -c vault -- env VAULT_SKIP_VERIFY=true \
  vault kv put kv/secret/n8n/live/postgres \
  POSTGRES_USER=postgres \
  POSTGRES_PASSWORD=<NEW_PASSWORD> \
  POSTGRES_DB=n8n \
  POSTGRES_NON_ROOT_USER=n8n_live \
  POSTGRES_NON_ROOT_PASSWORD=<NEW_PASSWORD>

# 2. Force ESO to re-sync immediately (instead of waiting 1h)
sudo microk8s kubectl annotate externalsecret postgres-external-secret -n n8n-live \
  force-sync=$(date +%s) --overwrite

# 3. Verify secret updated
sudo microk8s kubectl get secret postgres-secret -n n8n-live -o jsonpath='{.metadata.resourceVersion}'

# 4. Restart both pods to pick up new credentials
sudo microk8s kubectl rollout restart deployment -n n8n-live
```

---

## 12. Monitoring Verification

```bash
# Check ServiceMonitor is picked up by Prometheus
sudo microk8s kubectl get servicemonitor -n n8n-live

# Check Prometheus targets (port-forward to Prometheus)
sudo microk8s kubectl port-forward -n observability svc/prometheus-operated 9090:9090 &
# Visit http://localhost:9090/targets and search for "n8n"

# Check alert rules are loaded
# Visit http://localhost:9090/rules and search for "n8n"

# Check Grafana dashboard
sudo microk8s kubectl port-forward -n observability svc/grafana 3000:80 &
# Visit http://localhost:3000, search dashboards for "n8n Self-Hosted"
```

---

## 13. Upgrade n8n (new version)

**Used for 2.16.1 → 2.39.8 on 2026-09-19: 2m12s of webhook downtime, no data loss.**
Main and worker must never run different versions against one database, and both Deployments are `RollingUpdate maxSurge 1` — so a plain sync is unsafe for a version change.
The worker runs migrations too, which is why main is synced alone first.

```bash
K="sudo microk8s kubectl -n n8n-live"
```

**Prepare — no downtime**
1. Pick the target: `npm view n8n dist-tags` (use `stable`, not `beta`). Staying inside the current major needs no breaking-change work; crossing one does.
2. Resolve the multi-arch digest and pin tag **and** digest:
   ```bash
   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:n8nio/n8n:pull" \
     | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
   curl -sI -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" \
     https://registry-1.docker.io/v2/n8nio/n8n/manifests/<ver> | grep -i docker-content-digest
   ```
3. PR `values-live.yaml` (`image.tag: "<ver>@sha256:<digest>"`) and `Chart.yaml` (`appVersion`). Confirm `helm template -f values-live.yaml` differs from main only in the image and version labels. Merge — that deploys nothing.
4. Pre-pull on the node (saves ~2 min of downtime; no sudo needed):
   `$K run n8n-prepull --image=n8nio/n8n@sha256:<digest> --restart=Never --command -- node -e 0` → wait for the Pulled event → delete the pod.
5. Baselines to compare against afterwards: published workflows (`SELECT id FROM workflow_entity WHERE "activeVersionId" IS NOT NULL`), `webhook_entity` rows, and the newest `migrations` name.

**Cutover**
6. Copy the data dir off the node (it holds the `config` encryption key):
   `$K exec deploy/n8n -c n8n -- tar czf - -C /home/node/.n8n --exclude='n8nEventLog*' . > dot-n8n.tgz` → check it with `tar tzf`.
7. Stop main, drain the queue, stop the worker. **Downtime starts here.**
   ```bash
   $K scale deploy/n8n --replicas=0
   $K exec deploy/n8n-application-redis -- sh -c \
     'for q in active wait paused; do redis-cli llen bull:jobs:$q; done; redis-cli zcard bull:jobs:delayed'   # all 0
   $K scale deploy/n8n-application-worker --replicas=0
   ```
   Do **not** gate on `execution_entity."stoppedAt" IS NULL`: sub-workflows that don't save successful runs leave `running` rows that never clear.
8. Rollback copy, then a dump. The exporter sidecar holds a session on `n8n`, so block connections first:
   ```bash
   $K exec -i n8n-application-postgres-0 -c postgres -- psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL'
   ALTER DATABASE n8n ALLOW_CONNECTIONS false;
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'n8n' AND pid <> pg_backend_pid();
   CREATE DATABASE n8n_pre_<ver> TEMPLATE n8n;
   ALTER DATABASE n8n ALLOW_CONNECTIONS true;
   SQL
   $K create job --from=cronjob/n8n-application-db-backup pre-<ver>      # then copy the .sql.gz off the node
   ```
   Check the copy's row counts match live, and that the dump ends with "PostgreSQL database dump complete".
9. Sync **only** the main Deployment at the merged SHA (§4 sync + the `resources` line). Main runs the migrations — don't interrupt it, even if it looks stuck for several minutes.
   `/healthz/readiness` keeps it out of the Service until migrations finish, so **downtime ends when the pod is Ready**.
10. Full sync → the worker starts on the new version.

**Verify** — both pods' `imageID` digest, `n8n --version`, the newest `migrations` row, published workflows and `webhook_entity` against the baseline,
`$K exec deploy/n8n -c n8n -- n8n export:credentials --all --decrypted --output=/dev/null` exits 0, and the next scheduled runs succeed.

**Rollback** — §4 "Roll back an n8n version upgrade". Drop `n8n_pre_<ver>` about a week after the upgrade sticks.

---

## Emergency Contacts / Escalation

| Scenario | Action |
|---|---|
| n8n completely down | Restart deployment, check postgres, check secrets |
| Data loss suspected | Immediately stop writes (scale to 0), restore from latest backup |
| Security incident | Scale to 0, rotate all Vault secrets, check audit logs |
| Node OOM (host level) | `sudo journalctl -k | grep -i oom`, consider adding swap or increasing node resources |
