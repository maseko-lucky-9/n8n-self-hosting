# PostgreSQL Database Compatibility Fix

## Problem
The error "FATAL: database files are incompatible with server" occurs when PostgreSQL database files were created with a different version than the one currently running.

## Root Cause
This typically happens when:
1. The persistent volume contains data from a different PostgreSQL version
2. A PostgreSQL upgrade was attempted but not completed properly
3. The database files are corrupted or incompatible

## Solutions

### Option 1: Clear Persistent Volume (Recommended for Development)
If you can afford to lose the data (recommended for development environments):

1. **Delete the Persistent Volume Claim:**
   ```bash
   kubectl delete pvc postgresql-pv -n n8n-development
   ```

2. **Redeploy the application:**
   ```bash
   helm upgrade --install n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-dev.yaml
   ```

### Option 2: Use the Fix Script
Run the provided script for an interactive fix:
```bash
./fix-database-compatibility.sh
```

### Option 3: Manual Steps
1. **Check current state:**
   ```bash
   kubectl get pvc -n n8n-development
   kubectl get pods -n n8n-development -l service=postgres-n8n-svn
   ```

2. **Check PostgreSQL logs:**
   ```bash
   kubectl logs <postgres-pod-name> -n n8n-development
   ```

3. **Restart PostgreSQL deployment:**
   ```bash
   kubectl rollout restart deployment postgres -n n8n-development
   ```

## Changes Made

### 1. Enhanced PostgreSQL Deployment
Added compatibility environment variables to `helm/n8n-application/templates/postgres-deployment.yaml`:
- `POSTGRES_INITDB_ARGS`: Proper encoding and locale settings
- `POSTGRES_SHARED_PRELOAD_LIBRARIES`: Performance monitoring
- `POSTGRES_COMPATIBILITY_MODE`: Compatibility mode flag

### 2. Improved Init Script
Enhanced `helm/n8n-application/templates/postgres-configmap.yaml` with:
- Database compatibility checking
- Better error handling
- Proper startup sequence

### 3. Fix Script
Created `fix-database-compatibility.sh` with options to:
- Check current state
- Clear persistent volume
- Restart deployment
- Check logs

## Prevention
To prevent this issue in the future:

1. **Use specific PostgreSQL versions** in production
2. **Backup data before upgrades**
3. **Test upgrades in development first**
4. **Use database migration tools** for major version upgrades

## Current Configuration
- PostgreSQL Version: 15.3
- Database: n8n_dev
- Persistent Volume: postgresql-pv
- Namespace: n8n-development

## Next Steps
1. Choose your preferred solution from the options above
2. Execute the fix
3. Verify the application is working correctly
4. Consider implementing regular backups if not already in place 