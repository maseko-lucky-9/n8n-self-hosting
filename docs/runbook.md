# n8n MicroK8s Operations Runbook

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

# Scale workers down (in-flight jobs complete within terminationGracePeriodSeconds=120s)
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

## 4. Roll Back a Deployment

**When:** A new n8n version or config change causes issues.

```bash
# Check rollout history
sudo microk8s kubectl rollout history deployment/n8n -n n8n-live

# Roll back to previous revision
sudo microk8s kubectl rollout undo deployment/n8n -n n8n-live

# Roll back to specific revision
sudo microk8s kubectl rollout undo deployment/n8n -n n8n-live --to-revision=<N>

# Via Helm (preferred — rolls back all resources)
helm rollback n8n-application <REVISION> -n n8n-live
```

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
#    Then: helm upgrade n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-live.yaml -n n8n-live
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

```bash
# 1. Update secret in Vault
vault kv put secret/n8n/live/postgres \
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

## 13. Full Redeployment

**When:** Major version upgrade or complete infrastructure refresh.

```bash
# 1. Backup database first
sudo microk8s kubectl create job --from=cronjob/n8n-application-db-backup pre-upgrade-backup -n n8n-live

# 2. Wait for backup to complete
sudo microk8s kubectl wait --for=condition=complete job/pre-upgrade-backup -n n8n-live --timeout=300s

# 3. Update image tag in values-live.yaml, then:
helm upgrade n8n-application ./helm/n8n-application \
  -f ./helm/n8n-application/values-live.yaml \
  -n n8n-live

# 4. Watch rollout
sudo microk8s kubectl rollout status deployment/n8n -n n8n-live --timeout=180s

# 5. Verify
sudo microk8s kubectl get pods -n n8n-live
curl -I https://<your-domain>/healthz
```

---

## Emergency Contacts / Escalation

| Scenario | Action |
|---|---|
| n8n completely down | Restart deployment, check postgres, check secrets |
| Data loss suspected | Immediately stop writes (scale to 0), restore from latest backup |
| Security incident | Scale to 0, rotate all Vault secrets, check audit logs |
| Node OOM (host level) | `sudo journalctl -k | grep -i oom`, consider adding swap or increasing node resources |
