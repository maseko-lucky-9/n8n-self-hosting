# Network Exposure Guide for n8n Application

This guide explains how to properly expose your n8n application to the network using the MicroK8s nginx ingress controller.

## Prerequisites

1. **MicroK8s nginx Ingress Controller**: Ensure the `ingress` addon is enabled in MicroK8s (`microk8s enable ingress`)
2. **Domain Name**: `n8n.homelab.local` (resolved via local DNS/hosts)
3. **TLS Certificate**: Wildcard cert `homelab-tls` secret in the target namespace

## Configuration Steps

### 1. Ingress Architecture

The live ingress is **not** managed by the Helm chart. The Helm chart's ingress is disabled in the live environment (`ingress.enabled: false` in `values-live.yaml`). The authoritative ingress resource is:

```
homelab-infra/ingress/manifests/n8n-ingress.yaml
```

This manifest uses:

```yaml
ingressClassName: public   # MicroK8s nginx ingress addon
# Host: n8n.homelab.local
# TLS secret: homelab-tls  (wildcard cert, pre-provisioned)
# Annotations: nginx.ingress.kubernetes.io/auth-type: basic
```

For local/dev environments, you may enable the Helm-managed ingress in `values-local.yaml`:

```yaml
ingress:
  enabled: true
  ingressClassName: public
  hosts:
    - host: n8n.homelab.local
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: homelab-tls
      hosts:
        - n8n.homelab.local
```

### 2. TLS Certificate

The homelab uses a pre-provisioned wildcard TLS secret named `homelab-tls`. Ensure the secret exists in the target namespace before deploying:

```bash
kubectl get secret homelab-tls -n n8n-live
```

If it is missing, copy it from the source namespace or re-provision via your certificate management workflow.

### 3. Deploy the Application

````bash
```bash
# Run the deployment script from the repository root
scripts/deploy.sh
````

Alternatively, if running manually from root:

```bash
helm upgrade --install n8n-application ./helm/n8n-application -f ./helm/n8n-application/values-local.yaml -n n8n-local
```

````

### 4. Verify Deployment

Check that all resources are running:

```bash
kubectl get all -n n8n-local
kubectl get ingress -n n8n-local
kubectl describe ingress n8n-app-ingress -n n8n-local
````

### 5. Configure DNS

Point `n8n.homelab.local` to your MicroK8s node IP. You can find the ingress controller's external IP by:

```bash
kubectl get svc -n ingress ingress-nginx-controller
```

## Network Access

Once configured, your n8n application will be accessible at:

- **HTTPS**: `https://n8n.homelab.local`
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

1. **Ingress not working**: Check MicroK8s nginx ingress controller status (`kubectl get pods -n ingress`)
2. **TLS errors**: Verify `homelab-tls` secret exists in the target namespace and contains a valid wildcard cert
3. **DNS resolution**: Ensure `n8n.homelab.local` resolves to your MicroK8s node IP
4. **Service connectivity**: Verify n8n service is running

### Debug Commands

```bash
# Check ingress status
kubectl describe ingress -n n8n-live

# Check nginx ingress controller logs
kubectl logs -n ingress -l app.kubernetes.io/name=ingress-nginx

# Test service connectivity
kubectl port-forward -n n8n-live svc/n8n 5678:5678
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
