# Vault Secrets — Reelsmith Social Publish

All secrets live under the `kv` mount (v2), path prefix `secret/n8n/live/`.
The live Vault policy (`n8n-readonly`) already covers `kv/data/secret/n8n/live/*`,
so the existing `vault-backend` SecretStore can sync them without any policy changes.

## kv/secret/n8n/live/reelsmith-tiktok
- `client_key`    — TikTok app Client Key (developers.tiktok.com)
- `client_secret` — TikTok app Client Secret

## kv/secret/n8n/live/reelsmith-youtube
- `client_id`     — GCP OAuth2 Client ID (project: reelsmith-publisher)
- `client_secret` — GCP OAuth2 Client Secret

## kv/secret/n8n/live/reelsmith-telegram
- `bot_token`     — Telegram bot token from @BotFather
- `chat_id`       — Your Telegram user/chat ID (get from @userinfobot)

These two keys are projected into the n8n pod as `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` env vars via `extraEnv` in values-live.yaml — the workflow's
"Log Results" node reads them to send failure alerts.

## Write commands

```bash
vault kv put kv/secret/n8n/live/reelsmith-tiktok \
  client_key=<KEY> client_secret=<SECRET>

vault kv put kv/secret/n8n/live/reelsmith-youtube \
  client_id=<ID> client_secret=<SECRET>

vault kv put kv/secret/n8n/live/reelsmith-telegram \
  bot_token=<TOKEN> chat_id=<CHAT_ID>
```

## Verify ESO sync

```bash
ssh homelab "microk8s kubectl -n n8n-live get externalsecret \
  reelsmith-tiktok reelsmith-youtube reelsmith-telegram"
# All should show: STATUS=SecretSynced, READY=True

ssh homelab "microk8s kubectl -n n8n-live get secret \
  reelsmith-tiktok reelsmith-youtube reelsmith-telegram"
```
