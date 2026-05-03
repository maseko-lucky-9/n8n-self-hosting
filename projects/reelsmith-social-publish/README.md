# Reelsmith Social Publish

Reelsmith renders clips on your Mac → Syncthing replicates the export folder into
the cluster PVC → n8n watches `manifest.csv`, schedules each clip at a TZ-aware
peak window, and uploads to **TikTok Inbox (drafts)** and **YouTube (private)** in
parallel. Results land in `results.log.csv`; failures alert via Telegram.

## Prerequisites

1. **Vault** — write the three secrets documented in `vault/secrets.md`.
2. **TikTok app** — create at developers.tiktok.com, product: Content Posting API,
   scopes `user.info.basic` + `video.upload`, redirect URI:
   `https://n8n.homelab.local/rest/oauth2-credential/callback`
3. **GCP project** `reelsmith-publisher` — enable YouTube Data API v3; create an
   OAuth2 Web app client with the same redirect URI.
4. **Telegram bot** — token from @BotFather; get your `chat_id` from @userinfobot.
5. **n8n OAuth2 credentials** — after ESO syncs the secrets, create `reelsmith-tiktok`
   and `reelsmith-youtube` OAuth2 Generic credentials in the n8n UI and complete
   the browser consent flow.

## Deploy order

```bash
# 1. Write Vault entries (see vault/secrets.md)

# 2. Apply infra manifests
ssh homelab "microk8s kubectl apply -f -" < manifests/pvc-reelsmith-inbox.yaml
ssh homelab "microk8s kubectl apply -f -" < manifests/syncthing-deployment.yaml
ssh homelab "microk8s kubectl apply \
  -f manifests/external-secret-tiktok.yaml \
  -f manifests/external-secret-youtube.yaml \
  -f manifests/external-secret-telegram.yaml"

# 3. Register ArgoCD application (picks up the manifests/ dir automatically)
ssh homelab "microk8s kubectl apply -f -" < argocd/application.yaml

# 4. Upgrade Helm chart to mount the PVC on n8n + worker pods
cd helm && helm upgrade n8n-release n8n-application -f n8n-application/values-live.yaml

# 5. Import workflow and activate (n8n UI)
#    - Import workflow/reelsmith-social-publish.json
#    - Attach reelsmith-tiktok and reelsmith-youtube OAuth2 credentials
#    - Activate
```

## Mac setup

1. Set `YTVIDEO_EXPORT_BASE_FOLDER` in Reelsmith `.env` to your local Syncthing
   share folder (e.g. `~/Sync/reelsmith-inbox`).
2. Install Syncthing on your Mac. In the Syncthing web UI:
   - Add the homelab Syncthing as a remote device via `<node-ip>:32200`.
   - Share the folder targeting `/var/syncthing/reelsmith-inbox` on the cluster side.
   - Set Mac folder as **Send Only**, cluster side as **Receive Only**.
   - Add `.stignore`: `*.tmp`, `.DS_Store`, `processed/`

## Smoke test

```bash
# 1. ESO synced
ssh homelab "microk8s kubectl -n n8n-live get externalsecret \
  reelsmith-tiktok reelsmith-youtube reelsmith-telegram"
# Expect: STATUS=SecretSynced, READY=True for all three

# 2. PVC bound
ssh homelab "microk8s kubectl -n n8n-live get pvc syncthing-reelsmith-pvc"
# Expect: STATUS=Bound

# 3. n8n main pod has the volume
ssh homelab "microk8s kubectl -n n8n-live exec deploy/n8n -- ls /data/reelsmith-inbox"

# 4. n8n worker pod has the volume
ssh homelab "microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- ls /data/reelsmith-inbox"

# 5. Submit a job in Reelsmith, confirm manifest + clips sync into the PVC

# 6. After scheduled peak window: clip in TikTok drafts + YouTube Studio (private);
#    results.log.csv row written; processed/manifest-<ISO>.csv archived
```
