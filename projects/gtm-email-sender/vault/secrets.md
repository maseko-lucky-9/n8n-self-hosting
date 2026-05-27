# gtm-email-sender — Secrets Documentation

This file documents WHICH secrets the workflows depend on and WHERE they live. **Never paste actual secret values here.** Vault stores the truth.

## Vault paths (kv v2 mount)

| Path | Field | Used by | Notes |
|---|---|---|---|
| `kv/secret/n8n/live/app` | `N8N_ENCRYPTION_KEY` | All n8n credentials | **DO NOT ROTATE** — losing this means re-entering every credential manually |
| `kv/secret/n8n/live/gtm-notion` | `api_token` | `notion-gtm` credential | Notion internal integration token, scoped to GTM Prospects DB only |
| `kv/secret/n8n/live/gtm-resend` | `api_key` | `resend-api-key` credential | Format: `re_xxxxxxxxxxxxxxxx` |
| `kv/secret/n8n/live/gtm-resend` | `webhook_secret` | `gtm-bounce-handler` env | Format: `whsec_xxxx`; HMAC verification of Resend webhook payloads |
| `kv/secret/n8n/live/gtm-app` | `unsubscribe_hmac_secret` | All workflows handling slug+token | 64-char hex; **MUST match** `UNSUBSCRIBE_HMAC_SECRET` in `~/Repo/apps/n8n-gtm-research/.env` (same key signs and verifies) |
| `kv/secret/n8n/live/gtm-app` | `notion_gtm_db_id` | All workflows querying the DB | 32-char Notion DB ID |
| `kv/secret/n8n/live/gtm-gmail` | `client_id` | `gmail-gtm-mailbox` | Google OAuth2 client ID |
| `kv/secret/n8n/live/gtm-gmail` | `client_secret` | `gmail-gtm-mailbox` | Google OAuth2 client secret |
| `kv/secret/n8n/live/gtm-gmail` | `refresh_token` | `gmail-gtm-mailbox` | Long-lived refresh token from localhost OAuth flow |

## ESO ExternalSecret manifests (TODO)

ExternalSecret manifests are **not yet committed** — for Wk 1 we set env vars directly in n8n's Helm values, matching the existing Google Sheets manual pattern (see `demos/sme-professional-services/`).

When ready to formalise, add ExternalSecrets to `~/Repo/infra/homelab-infra/k8s/n8n-live/external-secrets/gtm-*.yaml` mirroring the reelsmith-telegram pattern at `projects/reelsmith-social-publish/`.

## Local (Mac) `.env` file

`~/Repo/apps/n8n-gtm-research/.env` — gitignored, `chmod 600`:

```
NOTION_API_TOKEN=<same as kv/secret/n8n/live/gtm-notion#api_token>
NOTION_GTM_DB_ID=<same as kv/secret/n8n/live/gtm-app#notion_gtm_db_id>
UNSUBSCRIBE_HMAC_SECRET=<same as kv/secret/n8n/live/gtm-app#unsubscribe_hmac_secret>
```

The HMAC secret MUST be identical on both sides — Mac signs the unsubscribe URL when generating drafts; n8n verifies on click. Mismatch breaks unsubscribe entirely.

## Rotation

| Secret | Rotation cadence | Procedure |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | NEVER (without coordinated re-credential entry) | n/a |
| Notion `api_token` | On suspected leak | Revoke at notion.so/my-integrations → generate new → update Vault → ESO refresh → update Mac `.env` |
| Resend `api_key` | Quarterly | Generate new in Resend dashboard → update Vault → ESO refresh; old key auto-revoked when replaced |
| Resend `webhook_secret` | On suspected leak | Regenerate in Resend webhook config → update Vault → restart n8n pod |
| `unsubscribe_hmac_secret` | On suspected leak | `openssl rand -hex 32` → update BOTH Vault AND Mac `.env` AT THE SAME TIME → re-run pipeline (existing in-flight unsubscribe links will be invalidated) |
| Gmail `refresh_token` | Lasts indefinitely | Re-do localhost OAuth flow if revoked |
