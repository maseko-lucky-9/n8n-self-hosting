# Network Exposure Guide for n8n Application

This guide explains how to properly expose your n8n application to the network using Kong ingress controller.

## Prerequisites

1. **Kong Ingress Controller**: Ensure Kong is installed and running in your cluster
2. **Domain Name**: You need a domain name pointing to your cluster's external IP
3. **TLS Certificate**: SSL certificate for your domain (Let's Encrypt recommended)

## Configuration Steps

### 1. Update Domain Configuration

Edit `helm/n8n-application/values-dev.yaml` and replace `n8n.yourdomain.com` with your actual domain:

```yaml
ingress:
  hosts:
    - host: n8n.yourcompany.com # Replace with your actual domain
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: n8n-tls
      hosts:
        - n8n.yourcompany.com # Replace with your actual domain
```

### 2. Create TLS Secret

You have two options for TLS certificates:

#### Option A: Let's Encrypt with cert-manager (Recommended)

Install cert-manager if not already installed:

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

Create a ClusterIssuer for Let's Encrypt:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@yourcompany.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: kong
```

Then update your ingress to use cert-manager:

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

#### Option B: Manual TLS Secret

If you have your own certificate:

```bash
kubectl create secret tls n8n-tls \
  --cert=path/to/your/certificate.crt \
  --key=path/to/your/private.key \
  --namespace=n8n-development
```

### 3. Deploy the Application

````bash
```bash
# Run the deployment script from the repository root
./deploy.sh
````

Alternatively, if running manually from root:

```bash
helm upgrade --install n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-dev.yaml -n n8n-development
```

````

### 4. Verify Deployment

Check that all resources are running:

```bash
kubectl get all -n n8n-development
kubectl get ingress -n n8n-development
kubectl describe ingress n8n-app-ingress -n n8n-development
````

### 5. Configure DNS

Point your domain to your cluster's external IP address. You can find this IP by:

```bash
kubectl get svc -n kong-system kong-proxy
```

## Network Access

Once configured, your n8n application will be accessible at:

- **HTTPS**: `https://n8n.yourdomain.com`
- **HTTP**: Will redirect to HTTPS

## Security Features

The current configuration includes:

- **HTTPS Enforcement**: All traffic is encrypted
- **CORS Support**: Configured for web applications
- **Rate Limiting**: 100 requests per minute
- **Security Headers**: Proper forwarding headers
- **TLS 1.2+**: Modern TLS protocols only

## Troubleshooting

### Common Issues

1. **Ingress not working**: Check Kong controller status
2. **TLS errors**: Verify certificate secret exists and is valid
3. **DNS resolution**: Ensure domain points to correct IP
4. **Service connectivity**: Verify n8n service is running

### Debug Commands

```bash
# Check ingress status
kubectl describe ingress -n n8n-development

# Check Kong logs
kubectl logs -n kong-system -l app=kong

# Test service connectivity
kubectl port-forward -n n8n-development svc/n8n 5678:5678
```

## Production Considerations

1. **Use specific n8n version**: Avoid "latest" tag
2. **External secrets**: Store database passwords securely
3. **Monitoring**: Set up Prometheus/Grafana
4. **Backup**: Configure database backups
5. **Scaling**: Enable autoscaling for production loads

## Next Steps

1. Update your domain in the values file
2. Choose and implement TLS certificate method
3. Deploy the updated configuration
4. Test external access
5. Configure monitoring and alerts
