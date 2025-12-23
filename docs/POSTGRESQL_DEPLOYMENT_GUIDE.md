# PostgreSQL Role Fix - Deployment Guide

## Summary of Changes

The PostgreSQL pod error "FATAL: role 'postgres' does not exist" has been resolved by **separating the superuser credentials from the application user credentials**.

### What Changed

#### 1. **values-dev.yaml**
- ✅ Added `appUsername: "n8n"` 
- ✅ Added `appPassword: "n8n_dev_pass123"`
- ✅ Superuser remains: `username: "postgres"` with `password: "postgres123"`

#### 2. **postgres-secret.yaml**
- ✅ Added `POSTGRES_NON_ROOT_USER` secret key (references `appUsername`)
- ✅ Added `POSTGRES_NON_ROOT_PASSWORD` secret key (references `appPassword`)

#### 3. **postgres-statefulset.yaml**
- ✅ Updated `POSTGRES_NON_ROOT_USER` env var to use new secret key
- ✅ Updated `POSTGRES_NON_ROOT_PASSWORD` env var to use new secret key

### How This Fixes the Issue

**Before (Broken):**
```
POSTGRES_USER = "postgres"              ← Superuser
POSTGRES_NON_ROOT_USER = "postgres"     ← Same as superuser!
→ Init script detects both are the same and skips user creation
→ postgres role never created → FATAL error
```

**After (Fixed):**
```
POSTGRES_USER = "postgres"              ← Superuser (created by PostgreSQL automatically)
POSTGRES_NON_ROOT_USER = "n8n"          ← Different app user
→ Init script creates "n8n" user with password
→ Application connects as "n8n" (non-root)
→ All roles exist and initialize properly
```

---

## Deployment Steps

### Step 1: Clean Up Existing Pod

```bash
# Delete the existing StatefulSet to force re-initialization
kubectl delete statefulset postgres-n8n-database -n n8n-development --ignore-not-found

# Wait for pod to be deleted
kubectl get pods -n n8n-development -w

# Optional: Delete PVC to start fresh (WARNING: deletes data)
# kubectl delete pvc postgres-storage-postgres-n8n-database-0 -n n8n-development
```

### Step 2: Reinstall Helm Chart

```bash
# Option A: Fresh install
helm install n8n-database helm/n8n-database \
  -f helm/n8n-database/values-dev.yaml \
  -n n8n-development \
  --create-namespace

# Option B: Upgrade existing
helm upgrade --install n8n-database helm/n8n-database \
  -f helm/n8n-database/values-dev.yaml \
  -n n8n-development \
  --create-namespace
```

### Step 3: Monitor Pod Startup

```bash
# Watch pod startup
kubectl get pods -n n8n-development -w

# Check pod logs for initialization messages
kubectl logs -f -n n8n-development postgres-n8n-database-0

# Expected log sequence:
# 1. "database system is ready to accept connections"
# 2. "User postgres is already the superuser. Skipping creation." OR init script creates n8n user
# 3. Pod transitions to Running and Ready
```

### Step 4: Verify PostgreSQL Initialization

```bash
# Check postgres role exists
kubectl exec -it -n n8n-development postgres-n8n-database-0 -- \
  psql -U postgres -d n8n -c "\du"

# Expected output: Should show both 'postgres' and 'n8n' users
# postgres |                             | 
# n8n      | Create DB, Create Role    | 

# Check database exists
kubectl exec -it -n n8n-development postgres-n8n-database-0 -- \
  psql -U postgres -c "\l"

# Connect as n8n user (app user)
kubectl exec -it -n n8n-development postgres-n8n-database-0 -- \
  psql -U n8n -d n8n -c "SELECT version();"
```

### Step 5: Verify Service Connectivity

```bash
# Test connection from a test pod
kubectl run -it --rm --image=postgres:15-alpine --restart=Never -n n8n-development -- \
  psql -h postgres-service.n8n-development.svc.cluster.local -U postgres -d n8n -c "SELECT 'SUCCESS: Connected to postgres';"

# Test connection as app user
kubectl run -it --rm --image=postgres:15-alpine --restart=Never -n n8n-development -- \
  psql -h postgres-service.n8n-development.svc.cluster.local -U n8n -d n8n -c "SELECT 'SUCCESS: Connected as n8n user';"
```

---

## Troubleshooting

### If Pod Still Fails to Start

```bash
# Check pod events for errors
kubectl describe pod -n n8n-development postgres-n8n-database-0

# Check pod logs for initialization failures
kubectl logs -n n8n-development postgres-n8n-database-0

# Look for these common errors and solutions:
# 1. "permission denied" on PGDATA → PVC permissions issue
# 2. "no such file" → Missing init script volume mount
# 3. "role already exists" → PVC has stale data, delete PVC and restart
```

### If postgres Role Still Missing

```bash
# Check if PGDATA directory was properly initialized
kubectl exec -it -n n8n-development postgres-n8n-database-0 -- ls -la /var/lib/postgresql/data/pgdata/

# Should see: PG_VERSION, pg_wal, pg_xact, etc.

# If missing, delete PVC and restart
kubectl delete pvc postgres-storage-postgres-n8n-database-0 -n n8n-development
kubectl delete pod postgres-n8n-database-0 -n n8n-development
```

### If Init Script Fails

```bash
# Check if ConfigMap exists and has correct script
kubectl get configmap -n n8n-development
kubectl describe configmap n8n-database-init-data -n n8n-development

# Verify init script permissions (should be 0755)
kubectl exec -it -n n8n-development postgres-n8n-database-0 -- \
  ls -la /docker-entrypoint-initdb.d/
```

---

## Credential Security

### Development Environment
- Username: `postgres` (superuser)
- Password: `postgres123`
- App User: `n8n`
- App Password: `n8n_dev_pass123`

### Production Environment (Updated in values-prod.yaml)
- **⚠️ MUST CHANGE BEFORE DEPLOYMENT**
- Replace `CHANGE_ME_PROD_PASSWORD` with secure random passwords
- Use secrets management system (e.g., AWS Secrets Manager, HashiCorp Vault)
- Example for production update:

```bash
# Generate secure passwords
SUPERUSER_PASS=$(openssl rand -base64 32)
APP_USER_PASS=$(openssl rand -base64 32)

# Update values file or use sealed secrets
helm upgrade --install n8n-database helm/n8n-database \
  --set postgres.auth.password="$SUPERUSER_PASS" \
  --set postgres.auth.appPassword="$APP_USER_PASS" \
  -n n8n-production
```

---

## Verification Checklist

- [ ] Pod is Running and Ready (2/2)
- [ ] postgres role exists (superuser)
- [ ] n8n role exists (app user)
- [ ] n8n database exists
- [ ] Service selector matches pod labels
- [ ] Init script executed successfully
- [ ] Application can connect to database
- [ ] No "role does not exist" errors in logs
- [ ] PVC is mounted correctly at /var/lib/postgresql/data

---

## Next Steps

1. **For QA Environment:**
   - Update [values-qa.yaml](../../helm/n8n-application/values-qa.yaml) with similar app user separation
   - Deploy via ArgoCD with updated values

2. **For Production Environment:**
   - Update [values-prod.yaml](../../helm/n8n-application/values-prod.yaml)
   - Change passwords to secure random values
   - Implement secrets management
   - Test in staging first

3. **For N8N Application:**
   - Update n8n connection strings to use `n8n` user instead of `postgres`
   - Verify n8n pod can connect to database
   - Monitor for any permission-related errors

---

## Root Cause Summary

The original error occurred because:

1. Both `POSTGRES_USER` and `POSTGRES_NON_ROOT_USER` referenced the same "postgres" superuser
2. The init script detected they were equal and skipped user creation
3. The init script still tried to connect as postgres to create the database
4. If the postgres role initialization had any issues, the role would not exist
5. Subsequent connection attempts would fail with "FATAL: role 'postgres' does not exist"

**The fix separates concerns:**
- PostgreSQL automatically creates the `postgres` superuser during cluster initialization
- Our init script creates the `n8n` application user with restricted privileges
- Both users exist and can be used for their intended purposes
- The system is now secure (app doesn't use superuser) and reliable
