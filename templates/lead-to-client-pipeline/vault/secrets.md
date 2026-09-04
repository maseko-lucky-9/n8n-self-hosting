# Secrets — lead-to-client pipeline

No ExternalSecret manifest is needed. n8n credentials are entered in the n8n UI and
encrypted at rest with `N8N_ENCRYPTION_KEY`; only that key comes from Vault
(`kv/secret/n8n/live/app`), and it already exists.

Never commit any value below. `<PLACEHOLDER>` only.

| n8n credential | Type | Holds | Used by |
|---|---|---|---|
| `Postgres leads` | Postgres | host `postgres-service`, port `5432`, **database `leads`**, user `n8n_app`, password = existing `POSTGRES_NON_ROOT_PASSWORD` | every Postgres node in A/B/C |
| `Lead pipeline HMAC` | Crypto | `hmacSecret` — shared with the Cloudflare Worker | WF-A `HMAC Expected`, WF-C `HMAC Expected` |
| `SMTP leads` | SMTP | host `smtpout.secureserver.net`, port `465`, **SSL/TLS ON**, user `<SMTP_USERNAME>` (must equal `from_email`/`reply_to` — GoDaddy rejects any other `From`), "Ignore SSL Issues" OFF | WF-A, WF-B |
| `ntfy_topic` | n8n **variable**, not a credential | 32 random hex chars, e.g. `openssl rand -hex 16`; set **only** in Settings → Variables, never in git | WF-A (urgent push), WF-B (SLA escalation), WF-C (stage change), WF-D (error alerts) |

## Creating `Postgres leads`

Clone the existing n8n Postgres credential and change **only** the database name to
`leads`. Same host, same role. The `leads` database is separate from `n8n` on purpose:
the chart's backup CronJob runs `pg_dump --clean --if-exists` against `n8n`, so a
restore of n8n would `DROP` business tables living inside it.

## The HMAC secret

Generate once, then set it in two places — n8n and the Worker:

```bash
openssl rand -hex 32          # keep out of git, out of the Obsidian vault, out of chat
```

- n8n → Credentials → new **Crypto** credential named `Lead pipeline HMAC` → paste as HMAC Secret.
- Worker → `npx wrangler secret put LEAD_HMAC_SECRET` (and `LEAD_WEBHOOK_URL`).

Two workflows verify against this one secret, each with its own signing base.
Both are SHA-256, hex, over a **fixed string** rather than the raw body — Workers and
n8n do not serialise JSON identically, so signing the body would fail intermittently
and unfalsifiably.

| Caller | Signs | Verified by |
|---|---|---|
| Cloudflare Worker → `POST /webhook/lead-intake` | `<ref>.<submittedAt>.<email-or-phone>` | WF-A `HMAC Expected` |
| Anything → `POST /webhook/lead-stage` | `<lead_id>.<facet>.<to_stage>.<submittedAt>` | WF-C `HMAC Expected` |

Both reject a `submittedAt` more than 300s from now, in either direction, which is what
caps replay. **`to_stage` and `facet` are inside WF-C's signing base on purpose**: a
signature that covered only the lead id could be captured and re-aimed at any other
transition, which would make the check cosmetic.

WF-C's GET path is the exception and carries no signature — a link click cannot send a
signed body. It authenticates by burning a single-use expiring token instead.

## SMTP

The domain is **GoDaddy-hosted, not Titan** — verified live: MX `smtp.secureserver.net` /
`mailstore1.secureserver.net`; SPF `include:secureserver.net -all`; DMARC
`p=quarantine adkim=r aspf=r`; no Titan DKIM record anywhere. Any earlier note calling this
a Titan relay was wrong.

SMTP never worked from this cluster before this PR: both n8n pods timed out connecting to
`smtpout.secureserver.net` on both `:465` and `:587`, because the chart's NetworkPolicy had
no SMTP egress rule at all. This PR adds egress on **465 only**, restricted to public IP
ranges (private/CGNAT/link-local excluded).

GoDaddy's relay only accepts mail whose `From` equals the authenticated mailbox, so the
sender is `<SMTP_USERNAME>` — any other address (e.g. `hello@prudentiadigital.co.za`)
would be rejected. That is why a **new** credential, `SMTP leads`, was created rather than
reusing `hello@...`. The pre-existing `SMTP account` credential (`<CRED_ID>`) is
deliberately left untouched — its other consumers are unknown.

**Trap:** with SSL/TLS toggled OFF on port 465, nodemailer waits for a plaintext SMTP
banner that never arrives — the resulting timeout is indistinguishable from a
NetworkPolicy drop. Confirm the toggle before chasing the network.

### Rotation required

`<SMTP_USERNAME>` is a full GoDaddy Workspace mailbox account with no app-password
support — i.e. a credential-stuffing target minus one factor — and it is already in this
public repo's git history. **MFA must be enabled on that mailbox.** Its address being in
history means obscurity is not, and never was, the control.

The credential id shown above as `<CRED_ID>`, and the Google OAuth credential id in
`demos/sme-professional-services/w1-client-intake.json`, are both present in this public
repo's git history (commits `5311e70`, `88f51a4`, `4ed4b96`) as well as at HEAD under
`demos/`. Removing them from HEAD, as this branch does for the SMTP one, is not
remediation — history is permanent and public. Neither id is repeated here: writing one
into a fresh line is the exact mistake this note exists to record.
The actual controls are:

- [ ] MFA enabled on the GoDaddy mailbox — rotated/confirmed: `<DATE>`
- [ ] GoDaddy mailbox password rotated: `<DATE>`
- [ ] Google OAuth credential (see `demos/sme-professional-services/`) rotated: `<DATE>`
