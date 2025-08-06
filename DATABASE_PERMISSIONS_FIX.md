# Database Permissions Fix for n8n

## Problem
The error "permission denied for schema public" occurs when the n8n user doesn't have the necessary permissions on the PostgreSQL database schema.

## Root Cause
This typically happens when:
1. The n8n user (`n8n_developer`) doesn't have proper permissions on the `public` schema
2. The database initialization script doesn't grant all required permissions
3. The database host configuration is incorrect
4. The user exists but lacks specific schema permissions

## Solutions

### Option 1: Use the Fix Script (Recommended)
Run the provided script for an automated fix:
```bash
./fix-database-permissions.sh
```

### Option 2: Manual Fix
1. **Restart PostgreSQL deployment to apply new permissions:**
   ```bash
   kubectl rollout restart deployment postgres -n n8n-development
   kubectl rollout status deployment postgres -n n8n-development
   ```

2. **Restart n8n deployment:**
   ```bash
   kubectl rollout restart deployment n8n -n n8n-development
   kubectl rollout status deployment n8n -n n8n-development
   ```

3. **Verify the fix:**
   ```bash
   kubectl get pods -n n8n-development
   kubectl logs <n8n-pod-name> -n n8n-development
   ```

### Option 3: Helm Upgrade
If you want to apply all changes at once:
```bash
helm upgrade --install n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-dev.yaml
```

## Changes Made

### 1. Enhanced PostgreSQL Init Script
Updated `helm/n8n-application/templates/postgres-configmap.yaml` with:
- **User creation/update logic**: Handles existing users gracefully
- **Comprehensive permissions**: Grants all necessary permissions on schema, tables, sequences, and functions
- **Default privileges**: Sets up default privileges for future objects
- **Schema ownership**: Makes the n8n user the owner of the public schema

### 2. Fixed Database Host Configuration
Updated `helm/n8n-application/templates/n8n-deployment.yaml`:
- Changed `DB_POSTGRESDB_HOST` from `postgres-service.n8n-development.svc.cluster.local` to `postgres-service`
- This ensures proper service discovery within the same namespace

### 3. Comprehensive Permissions Granted
The init script now grants:
- `USAGE` on the `public` schema
- `ALL PRIVILEGES` on all tables, sequences, and functions
- `CREATE` privilege on the `public` schema
- Default privileges for future objects
- Schema ownership

## Verification Steps

### 1. Check PostgreSQL Logs
```bash
kubectl logs <postgres-pod-name> -n n8n-development | grep -i "n8n user setup"
```

### 2. Check n8n Logs
```bash
kubectl logs <n8n-pod-name> -n n8n-development | grep -i "database"
```

### 3. Test Database Connection
```bash
# Connect to PostgreSQL pod
kubectl exec -it <postgres-pod-name> -n n8n-development -- psql -U n8n_dev -d n8n_dev

# Check user permissions
\du n8n_developer
```

## Troubleshooting

### If the issue persists:

1. **Check if the init script ran:**
   ```bash
   kubectl logs <postgres-pod-name> -n n8n-development | grep -i "n8n user setup"
   ```

2. **Manually grant permissions:**
   ```bash
   kubectl exec -it <postgres-pod-name> -n n8n-development -- psql -U n8n_dev -d n8n_dev -c "
   GRANT USAGE ON SCHEMA public TO n8n_developer;
   GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO n8n_developer;
   GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO n8n_developer;
   GRANT CREATE ON SCHEMA public TO n8n_developer;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO n8n_developer;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO n8n_developer;
   "
   ```

3. **Clear and recreate the database (if possible):**
   ```bash
   kubectl delete pvc postgresql-pv -n n8n-development
   helm upgrade --install n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-dev.yaml
   ```

## Prevention
To prevent this issue in the future:

1. **Always test database permissions** in development first
2. **Use consistent user naming** across environments
3. **Implement proper database initialization** scripts
4. **Monitor database logs** for permission issues
5. **Use database migration tools** for schema changes

## Current Configuration
- **Database**: n8n_dev
- **User**: n8n_developer
- **Schema**: public
- **Host**: postgres-service
- **Port**: 5432
- **Namespace**: n8n-development

## Next Steps
1. Run the fix script or apply the manual fix
2. Verify the application is working correctly
3. Test database operations in n8n
4. Monitor logs for any remaining issues
5. Consider implementing regular database backups 