# Secrets — lead-to-client pipeline

n8n credentials (Postgres/Crypto/SMTP) are entered in the n8n UI and encrypted at rest
with `N8N_ENCRYPTION_KEY`, which comes from Vault (`kv/secret/n8n/live/app`) and already
exists. **Config values are a different story** (see "Config: \$env, not n8n
Variables" below) — two of them (`from_email`, `ntfy_topic`) are secret-adjacent enough
to need their own Vault path and their own ExternalSecret manifest, added in
`helm/n8n-application/templates/external-secret.yaml`.

Never commit any value below. `<PLACEHOLDER>` only.

| n8n credential | Type | Holds | Used by |
|---|---|---|---|
| `Postgres account` | Postgres | host `postgres-service`, port `5432`, **database `leads`**, user `n8n_app`, password = existing `POSTGRES_NON_ROOT_PASSWORD` | every Postgres node in A/B/C |
| `Crypto account` | Crypto | `hmacSecret` — shared with the Cloudflare Worker | WF-A `HMAC Expected`, WF-C `HMAC Expected` |
| `SMTP account 2` | SMTP | host `smtpout.secureserver.net`, port `465`, **SSL/TLS ON**, user `<SMTP_USERNAME>` (must equal `from_email`/`reply_to` — GoDaddy rejects any other `From`), Client Host Name `<SENDING_DOMAIN>` | WF-A, WF-B |
| `ntfy_topic` | n8n **variable**, not a credential | 32 random hex chars, e.g. `openssl rand -hex 16`; set **only** in Settings → Variables, never in git | WF-A (urgent push), WF-B (SLA escalation), WF-C (stage change), WF-D (error alerts) |

## Config: `$env`, not n8n Variables

n8n Variables (Settings -> Variables, `$vars` in expressions) are an
**Enterprise-licensed feature**. Confirmed against the live instance, not assumed:

```
$ n8n license:info
isValid: false
entitlements: 0

$ SELECT count(*) FROM variables;
0
```

`VariablesService.canCreateNewVariable()` throws `FeatureNotLicensedError('feat:variables')`
on this Community Edition instance, so Settings -> Variables cannot hold any config here.
All four workflows read `$env.X` instead (a 1:1 rename from `$vars.X` -- see each
workflow's jsCode/expressions).

**Non-secret values** (`brand`, `site_url`, `booking_url`, `followup_days`,
`daily_send_cap`, `sla_hours_urgent`, `urgent_timelines`, `urgent_budgets`) are plain
`extraEnv` entries in `helm/n8n-application/values-live.yaml`. Edit and redeploy via
the normal chart flow -- no Vault involved.

**`from_email` and `ntfy_topic`** are wired separately, via their own ExternalSecret
(`n8n-lead-pipeline-secret`, isolated from `n8n-app-secret` so a missing key here can
never risk `N8N_ENCRYPTION_KEY`). Populate before the first send:

```bash
vault kv put kv/secret/n8n/live/lead-pipeline \
  LEAD_FROM_EMAIL="<the mailbox that also holds the SMTP credential>" \
  LEAD_NTFY_TOPIC="$(openssl rand -hex 16)"
```

Both env vars are consumed with `optional: true` -- leaving this path unpopulated
means `from_email`/`ntfy_topic` resolve empty in the workflow (a loud, visible
failure: an empty `fromEmail` rejects at send time), not a crashed pod.

**`ntfy_topic` must never be a literal anywhere in git.** ntfy public topics are
unauthenticated in *both* directions -- the topic name is the only thing standing in
for a secret, so a committed topic is a published one. `config.example.json` carries
`<NTFY_TOPIC>` for exactly this reason.

## Creating `Postgres account`

Clone the existing n8n Postgres credential and change **only** the database name to
`leads`. Same host, same role. The `leads` database is separate from `n8n` on purpose:
the chart's backup CronJob runs `pg_dump --clean --if-exists` against `n8n`, so a
restore of n8n would `DROP` business tables living inside it.

## The HMAC secret

Generate once, then set it in two places — n8n and the Worker:

```bash
openssl rand -hex 32          # keep out of git, out of the Obsidian vault, out of chat
```

- n8n → Credentials → new **Crypto** credential named `Crypto account` → paste as HMAC Secret.
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

### The credential form, field by field

Verified against the running node package on this instance (`Smtp.credentials.js`), not
from documentation — the field set differs between n8n versions.

| Field | Value | Where it comes from |
|---|---|---|
| User | `<SMTP_USERNAME>` | The mailbox address itself. It **must** equal `from_email`/`reply_to`: GoDaddy relays only mail from the authenticated mailbox. |
| Password | `<SMTP_PASSWORD>` | The mailbox's own password, from the GoDaddy Email & Office dashboard — not the GoDaddy *account* password, and there are no app passwords on this product. Reset it there if unknown. |
| Host | `smtpout.secureserver.net` | GoDaddy's outbound relay for legacy Workspace Email, which is what the MX records show this domain uses. A Microsoft-365-backed GoDaddy mailbox would need `smtp.office365.com` instead — check MX before assuming. |
| Port | `465` | The only port the NetworkPolicy permits. 587 and 25 are deliberately dropped. |
| SSL/TLS | **ON** | 465 is implicit TLS. Off = nodemailer waits for a plaintext banner that never comes. |
| Disable STARTTLS | *should not be visible* | It only renders when SSL/TLS is OFF. If you can see it, SSL/TLS is off — turn it back on. |
| Client Host Name | `<SENDING_DOMAIN>` | Optional but recommended. It becomes the EHLO identity (nodemailer's `name`). Left blank, nodemailer uses the container hostname — a pod name like `n8n-68c95f7c77-pdcpl`, which is not an FQDN and changes on every redeploy. |

**"Ignore SSL Issues" is not on this credential.** It is an option on the Send Email
*node* (`allowUnauthorizedCerts`). Both mail nodes ship with `options` empty, which is
the safe default. Never add it to silence a connection hang: on this cluster a hang is
far more likely to be a NetworkPolicy drop or SSL/TLS left off, and disabling
certificate verification to "fix" it exposes the mailbox password on the wire.


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
would be rejected. That is why a **new** credential, `SMTP account 2`, was created rather than
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
