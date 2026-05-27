# gtm-email-sender — n8n project

Automated send + measure loop for Prudentia Digital n8n GTM outreach.

- **Source pipeline:** `~/Repo/apps/n8n-gtm-research/` writes drafts to Notion DB "GTM Prospects"
- **n8n role:** sends approved emails at 08:00 SAST daily; tracks bounces, replies, unsubscribes
- **Email provider:** Resend (SMTP + bounce webhooks)
- **Sender:** `gtm@prudentiadigital.co.za`
- **Compliance:** POPIA — every email includes HMAC-signed unsubscribe link

## Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `gtm-email-sender.json` | Schedule, daily 08:00 SAST | Query Notion `status=approved` rows → send via Resend → mark `sent` |
| `gtm-bounce-handler.json` | Webhook (Resend posts) | On bounce/complaint → mark Notion `status=bounced` or `unsubscribed` |
| `gtm-reply-tracker.json` | Schedule, every 30 min | Poll `gtm@prudentiadigital.co.za` Gmail → match `In-Reply-To` → mark `replied` |
| `gtm-unsubscribe.json` | Webhook (HTML page posts) | Verify HMAC → mark Notion `status=unsubscribed` |
| `gtm-error-handler.json` | n8n Error Trigger | Set as Error Workflow on the four above → ntfy urgent alert |

## Pre-flight Checklist (run BEFORE first production send)

### Infrastructure prereqs (Day 0)

- [ ] Cloudflare DNS for `prudentiadigital.co.za`:
      `SPF` TXT: `v=spf1 include:_spf.resend.com ~all`
      `DKIM` 2× CNAME records from Resend dashboard
      `DMARC` TXT: `v=DMARC1; p=none; rua=mailto:dmarc@prudentiadigital.co.za; pct=100`
- [ ] Resend account created; domain `prudentiadigital.co.za` verified (status: "verified")
- [ ] Resend API key generated (scope: "Sending access")
- [ ] Resend webhook secret generated; webhook configured to POST to `https://n8n.homelab.local/webhook/gtm-bounce` for events `email.bounced` and `email.complained`
- [ ] Mailbox `gtm@prudentiadigital.co.za` exists (Cloudflare Email Routing → forward to `ltmaseko7@gmail.com`)
- [ ] Notion database "GTM Prospects" created with all 22 properties from `~/Repo/apps/n8n-gtm-research/docs/notion-schema.md` (or reproduce from the v2 schema in the plan)
- [ ] Notion internal integration `n8n-gtm-sender` created; database shared with it
- [ ] Static `web/unsubscribe.html` deployed to Cloudflare Pages at `prudentiadigital.co.za/unsubscribe` (replace the `WEBHOOK_URL` constant in the page with the actual n8n webhook URL — note `.local` will only work on LAN; for public access route via Cloudflare Tunnel)
- [ ] POPIA LIA committed at `~/Repo/apps/n8n-gtm-research/docs/popia-lia.md`
- [ ] Privacy policy live at `prudentiadigital.co.za/privacy`

### n8n environment variables

Set on the `n8n-live` deployment via Vault → ESO (preferred) or directly in Helm `values-live.yaml`:

| Env var | Value | Notes |
|---|---|---|
| `NOTION_GTM_DB_ID` | `<32-char Notion DB ID>` | from Notion DB URL |
| `UNSUBSCRIBE_HMAC_SECRET` | `<64-char hex>` | MUST match the value in `~/Repo/apps/n8n-gtm-research/.env` — same key signs and verifies |
| `RESEND_WEBHOOK_SECRET` | `whsec_xxxx` | from Resend webhook config |
| `GTM_DAILY_CAP` | `10` | safety cap |
| `GTM_FROM_EMAIL` | `gtm@prudentiadigital.co.za` | sender address |
| `GTM_FROM_NAME` | `Thulani Maseko · Prudentia Digital` | display name |
| `DEV_OVERRIDE_TO` | `ltmaseko7@gmail.com` | **canary mode — set for first 3 days, unset for production** |

### n8n credentials (manual UI setup, mirrors Google Sheets pattern)

| Credential name | Type | Notes |
|---|---|---|
| `notion-gtm` | Notion API | Internal integration token |
| `resend-api-key` | HTTP Header Auth | Header `Authorization`, value `Bearer re_xxxx` |
| `gmail-gtm-mailbox` | Gmail OAuth2 | Use localhost OAuth callback workaround — `n8n.homelab.local` won't work for OAuth redirect |

#### Gmail OAuth on `.local` workaround
1. On the Mac, run a temporary local server: `python3 -m http.server 8080`
2. Use the n8n Gmail OAuth flow but override the redirect URI to `http://localhost:8080/oauth-callback`
3. Capture the auth code from the redirect URL
4. Manually paste the auth code into n8n's credential creation flow
5. n8n exchanges the code for a refresh token (which doesn't require a public callback — only the initial code exchange does)

### Import workflows

```bash
# From the homelab Mac/laptop:
cp ~/Repo/infra/n8n/n8n-self-hosting/projects/gtm-email-sender/workflows/*.json /tmp/

# In n8n UI: Workflows → ⋮ → Import from File → select each JSON
# After import, re-bind credentials (replace REPLACE_AT_IMPORT placeholders)
```

### Activate order

1. `gtm-error-handler` — activate first (other workflows reference it)
2. `gtm-bounce-handler` — activate (passive, waits for Resend webhooks)
3. `gtm-unsubscribe` — activate (passive, waits for unsubscribe clicks)
4. `gtm-reply-tracker` — activate (polls Gmail every 30 min)
5. `gtm-email-sender` — **DO NOT ACTIVATE YET**

## Canary Test (Day 1-3)

With `DEV_OVERRIDE_TO=ltmaseko7@gmail.com` set:

1. Run pipeline `cd ~/Repo/apps/n8n-gtm-research && .venv/bin/python -m src.orchestrator --max-companies 1`
2. Verify Notion row appears with `status=draft`
3. Manually approve in Notion: set `status=approved`, fill `email_address` with `ltmaseko7@gmail.com`
4. Manually trigger `gtm-email-sender` workflow in n8n UI
5. Verify:
   - Email arrives in `ltmaseko7@gmail.com` (not the address in Notion — DEV_OVERRIDE wins)
   - Notion row updates `status=sent`, `sent_at` populated, `resend_message_id` populated
6. Reply to the email from `ltmaseko7@gmail.com`
7. Wait ≤30 min → verify Notion `status=replied`, ntfy fires
8. Click the unsubscribe link → verify Notion `status=unsubscribed`
9. Send a deliberate bounce: change `email_address` to `bounce@simulator.amazonses.com` (or use Resend's test bounce address) → re-trigger → verify `status=bounced` after Resend webhook fires
10. Send one canary to `mail-tester.com` test address → score must be ≥9/10

## Production Cutover (Day 4)

After 3 clean canary days:

```bash
# 1. Unset DEV_OVERRIDE_TO from n8n env (Vault → ESO → restart n8n pod)
kubectl rollout restart deployment/n8n -n n8n-live

# 2. Verify env var no longer set inside the pod
kubectl exec -n n8n-live deploy/n8n -- env | grep DEV_OVERRIDE_TO
# (should be empty)

# 3. Activate gtm-email-sender workflow in n8n UI

# 4. Watch ntfy + Notion at next 08:00 SAST
```

## Disaster Recovery

- Workflows: re-import from Git (this directory)
- Credentials: see `vault/secrets.md`
- Notion data: backed up by Notion (no local export by default; consider weekly export to repo if scale increases)
- n8n encryption key: at `kv/secret/n8n/live/app` field `N8N_ENCRYPTION_KEY` — losing this means re-entering all credentials manually

## Operational Cadence

- **Daily 08:00 SAST:** auto-send loop fires; check ntfy summary
- **Weekly:** review `status=replied` rows in Notion; manually advance to discovery call
- **Weekly:** check `status=bounced` rate; if >5%, investigate sender reputation
- **Monthly:** export workflow JSONs (`n8n export:workflow`) and `git diff` against this repo to catch UI-side drift
- **Quarterly:** review `docs/popia-lia.md`; advance DMARC `p=none` → `p=quarantine` after 30 clean days
