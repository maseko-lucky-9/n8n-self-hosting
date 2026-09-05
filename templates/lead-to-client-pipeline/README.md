# Lead-to-client pipeline

A reusable, stateful funnel for professional services: **enquiry in → client signed**.
Replicates the pipeline diagrammed in a TikTok by @structurewebworks, with the twelve
things that video leaves out.

Source analysis: `$V/raw/watched/law-firm-lead-pipeline-1-vs-1m-2026-09-03/report.md`.
Pattern reference: `~/.claude/skills/n8n/references/pipeline-pattern.md`.

## The shape

```
[LEAD IN] → [CONTACT CREATED] → [SERVICE TAGGED] → <Urgent?>
                                                      No ↓   Yes → [CONFIRMATION] → [CONSULT BOOKED]
                                            [FOLLOW-UP SEQUENCE] ←────────────────────────┘
                                                      ↓
                                            [CONSULTATION CALL]   (human)
                                                      ↓
                                              [PROPOSAL SENT] ←──────────┐
                                                      ↓                  │
                                                  <ACCEPTED?>            │
                                             No ↓            Yes ↓       │
                                     [PAYMENT PENDING]  [CLIENT SIGNED] ─┘
                                                              ↓
                                                    [ENGAGEMENT OPENED]
```

Everything from CONSULT BOOKED rightward is **not seven automations — it is values of
two columns.** One table, one signed webhook, one transition map.

## Two facets, not one stage

A lead can be `payment_pending` *and* `consult_booked` at the same time: you sent a SOW,
they booked a scoping call before paying. A single `stage` enum forces you to discard
one, and the transition guard would reject the booking outright. So:

| Column | Values |
|---|---|
| `commercial_stage` | `lead_in → contacted → proposal_sent → {proposal_accepted \| payment_pending} → client_signed → engagement_opened`, plus `lost` |
| `calendar_stage` | `none → consult_booked → consultation_done` |

`payment_pending → proposal_sent` is the video's retry loop.

## Workflows

| File | Trigger | Does |
|---|---|---|
| `wf-a-lead-intake.json` | `POST /webhook/lead-intake` | HMAC + honeypot + freshness → upsert lead + submission + event (one atomic statement) → urgency switch → ntfy push (urgent only) → respond. **Sends no acknowledgement** — the Cloudflare Worker owns that (`SEND_AUTO_ACK`), so only one reaches the visitor |
| `wf-b-lead-followup.json` | 08:00 SAST daily; hourly SLA check | send due touches with jitter and a daily cap, every mail carrying a working opt-out; escalate urgent leads untouched past the SLA |
| `wf-c-lead-stage.json` | `POST`/`GET /webhook/lead-stage` | the state machine: resolve (or burn a single-use token) → transition guard → apply + audit → per-stage side effect |
| `wf-d-error-handler.json` | Error Trigger | ntfy alert with the message inline |
| `wf-e-sheet-sync.json` | `*/15 * * * *` | resolve the mirror spreadsheet by name via Drive → read-only snapshot of `leads` + `lead_events` into it. Postgres stays the system of record; nothing writes back, and no document id is stored in the workflow |

## Install

```bash
# 1. database (separate from n8n's own -- see vault/secrets.md for why)
kubectl -n n8n-live exec sts/n8n-application-postgres -c postgres -- \
  psql -U postgres -d postgres -c "CREATE DATABASE leads OWNER n8n_app"
kubectl -n n8n-live exec sts/n8n-application-postgres -c postgres -- \
  psql -U postgres -d leads -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"
kubectl -n n8n-live cp schema.sql n8n-live/n8n-application-postgres-0:/tmp/ -c postgres
kubectl -n n8n-live exec sts/n8n-application-postgres -c postgres -- \
  psql -v ON_ERROR_STOP=1 -U n8n_app -d leads -f /tmp/schema.sql

# 2. credentials -- create the three in vault/secrets.md, in the n8n UI

# 3. workflows -- first import only. Already imported and editing the JSON
#    instead? import-workflows.sh has no update mode and will create a
#    duplicate set -- see the header comment in that script before re-running.
../../scripts/import-workflows.sh . --dry-run     # validate first
../../scripts/import-workflows.sh .
```

Then in the n8n UI: attach credentials (imported nodes carry `REPLACE_*` placeholder
ids) and set **WF-D as the Error Workflow** on A/B/C before activating. Config does
**not** go through the n8n UI on this instance — n8n Variables (Settings → Variables)
are an Enterprise-licensed feature and unavailable here; see "Config (`$env`, not n8n
Variables)" below for how values actually reach the workflows.

**Blocking pre-activation gate for WF-B:** `webhook_base` must be a publicly resolvable
URL before WF-B (`wf-b-lead-followup.json`) is activated. WF-B is a *scheduled* workflow
that fires against existing lead rows the moment SMTP works, and it builds every
nurture email's unsubscribe link from `webhook_base`. If that value is a LAN-only
ingress host, the opt-out link is dead for every external recipient — a
POPIA s69 / s11(3) exposure for direct marketing with a non-functional opt-out. Verify
with `curl -sI <unsubscribe-url>` run from **outside** the network (a mobile hotspot,
an external host, anything off-LAN); a curl run from inside the homelab passes and
proves nothing.

## Sheet mirror (WF-E)

A read-only view of the pipeline for people who will not open a database. It is a
**scheduled snapshot**, not a write hanging off WF-A, and that is the whole design:

- **Isolation.** Nothing is added to the intake path, so no Sheets outage, quota trip or
  schema drift can stop a lead being accepted.
- **No drift.** A per-event write would mirror only the workflow it hangs off — WF-B's
  `Mark Touched` and WF-C's `Apply Transition` would leave the sheet stale.
- **Self-healing.** A cell someone edits by hand is overwritten within 15 minutes.
  Postgres is authoritative by construction, not by convention.

### Setup

**No document id is ever pasted into a node.** `Find Sheet` resolves the spreadsheet by
name through the Drive API on every run, so the sheet can be deleted and recreated
without editing the workflow. What matters instead is that the **name** is exact.

1. Create a spreadsheet named exactly **`Prudentia Leads Mirror`** (override with
   `$env.lead_sheet_name` if you want a different one), with two tabs named exactly
   `leads` and `events`.

2. Paste the header row into **A1** of each tab. These are tab-separated — paste, do not
   retype: every name must match a SQL alias in WF-E exactly, and `appendOrUpdate` keys
   on the first column of each tab.

   `leads`:
   ```
   lead_id	name	email_norm	phone_norm	service_type	urgency	commercial_stage	calendar_stage	touch_number	next_touch_at	stopped_at	stop_reason	created_at	updated_at
   ```

   `events`:
   ```
   event_id	lead_id	facet	from_stage	to_stage	actor	payload	created_at
   ```

3. Share the spreadsheet with the service-account email as **Editor** (see
   `../../docs/google-sheet-setup.md` for where to find it). A sheet the service account
   cannot see is indistinguishable from one that does not exist — both are zero search
   results, and both fail with the same message.

> **Why creating the sheet is manual.** Service accounts have no Drive storage quota and
> cannot own files, so `spreadsheet:create` under this credential fails
> ([n8n#26050](https://github.com/n8n-io/n8n/issues/26050)). The escapes are a Workspace
> shared drive or OAuth delegation; this domain is GoDaddy-hosted, not Workspace, so
> neither applies. Creating tabs and writing rows inside a sheet the service account has
> been *shared into* needs no ownership and is fully automated.

### Traps

Each of these was read out of the deployed n8n 2.16.1 node source, not inferred:

- **`cellFormat` is set to `RAW` on purpose.** The node default from v4.1 is
  `USER_ENTERED`, which parses and coerces every value it writes — ISO timestamps come
  back as locale-formatted dates. Nothing reads back from the sheet, so this is cosmetic
  here, but do not "tidy" it away.
- **Renaming or inserting a column breaks the sync.** `checkForSchemaChanges` throws for
  node version ≥ 4.4. It breaks the report, never intake — that is the intended blast
  radius, and it is the thing to test after any change.
- **`appendOrUpdate` writes into a hardcoded `!A:Z` range.** 14 columns now, 12 spare.
- **Deleted leads linger.** Nothing deletes leads today (`purge_after` exists but no
  workflow reads it). Add a Clear-then-Append only if that changes.
- **`onError` is left at the default deliberately.** A sync failure *should* raise and
  reach WF-D. Do not copy the ntfy nodes' `continueRegularOutput` — this is a report,
  and failing loudly is correct.
- **No `alwaysOutputData` on the two Postgres reads.** An empty table must yield zero
  items, not one empty item that the Sheets node would happily write as a blank row.
- **`Find Sheet` *does* set `alwaysOutputData`, and must.** Without it, zero search
  results means `Resolve Sheet ID` never executes, and the sync silently does nothing
  instead of failing. A no-op that looks like success is the worst outcome available.
- **The Drive search uses the advanced query mode, not "search by name".** `searchMethod:
  'name'` builds `name contains '<x>'` — a substring match that would also hit
  "Copy of <x>" and "<x> OLD". The query mode passes `name = '...'` to the API verbatim,
  and pins `mimeType` to a spreadsheet and `trashed = false`.
- **Two files can share an exact name in Drive.** `Resolve Sheet ID` requires exactly one
  match and throws otherwise, rather than taking `.first()` — picking the wrong one would
  write lead PII into someone else's document.

### PII

The sheet carries names, emails and phone numbers, and Sheets has no row-level
permissions: everyone it is shared with sees every prospect's full contact details.
Under POPIA that is a trans-border information flow (s72) needing its own lawful basis
plus an operator agreement (s21). To share more narrowly, drop `email_norm` and
`phone_norm` from `Select All Leads` — the mirror is reversible in a way a datastore
migration would not have been.

## Config (`$env`, not n8n Variables)

n8n Variables are an Enterprise-licensed feature and unavailable on this Community
Edition instance (`n8n license:info` -> `isValid: false`) -- so despite the workflow
JSON's expressions all reading `$env.X`, this is **not** a plain OS environment
variable you export by hand. It is wired through the Helm chart: non-secret values
via `extraEnv` in `values-live.yaml`, and `from_email`/`ntfy_topic` via a dedicated
Vault path and ExternalSecret. See `vault/secrets.md` -> "Config: \$env, not n8n
Variables" for the exact values, the Vault command, and why those two are separated
from the rest. Defaults for all of them live in `config.example.json`, which stays
useful as a reference even though nothing reads that file directly at runtime.

`brand`, `from_email`, `site_url`, `booking_url`, `ntfy_topic`, `followup_days` (**JSON
array string only** — both consumers call bare `JSON.parse`, unlike
`urgent_timelines`/`urgent_budgets` below), `daily_send_cap`, `sla_hours_urgent`,
`urgent_timelines`, `urgent_budgets` (comma-separated) are wired as above and live
in `extraEnv`/the lead-pipeline Secret today.

`reply_to` is listed in `config.example.json` for completeness but is not read by any
workflow node -- nothing needs it wired yet. `webhook_base` and `timezone` are not
wired as env vars either: `webhook_base` is deliberately unset until it has a public
route (see the WF-B blocking gate above), and `timezone` is a WF-B scheduling concept
that has no `$env` consumer in the current workflows.

## What the source video omits, and where it is handled

| # | Gap | Handled |
|---|---|---|
| 1 | Replayed webhook duplicates the contact | partial unique index + `ON CONFLICT`; `submissions.ref` is `ON CONFLICT DO NOTHING` |
| 2 | Returning lead not recognised | `existed` flag → `resubmitted` event + notify, no duplicate welcome |
| 3 | No bot filter | honeypot + HMAC + 300s freshness window |
| 4 | One API failure silently drops a lead | WF-D on all three workflows |
| 5 | Follow-ups never stop | `stopped_at` with three producers: opt-out link, booking, `lost` |
| 6 | Domain gate (conflict check) | N/A for professional services; add a node before the upsert if needed |
| 7 | No consent trail | `consent_source`/`consent_at` + append-only `lead_events` |
| 8 | No retention policy | `purge_after` defaults to +13 months, matching the site's KV TTL |
| 9 | No speed-to-lead SLA | hourly branch in WF-B → ntfy |
| 10 | Night-time messaging | the 08:00 schedule is the whole control now; intake sends email only, so there is no night-time send to suppress |
| 11 | No attribution | `submissions` holds `source`/`utm_*`/`entry_point`/`topic` |
| 12 | No reporting | `lead_events` is append-only; the postgres-exporter already scrapes this instance |

## Gotchas worth keeping

- **`queryReplacement` splits on commas.** A resolvable returning `Acme, Inc` becomes two
  parameters and silently misaligns the query. Every Postgres node here passes one
  `JSON.stringify(...)` object and unpacks it in SQL with `->>`.
- **`require('crypto')` is unavailable** — `NODE_FUNCTION_ALLOW_BUILTIN=fs,path`. HMAC is
  the Crypto node (secret in a credential, not the workflow JSON). Random tokens use
  `crypto.getRandomValues`, which is a global.
- **A link click is a GET** and cannot carry an HMAC body. Opt-out and proposal-accept
  links use opaque single-use expiring tokens instead — an HMAC in a URL is replayable
  forever and leaks into browser history and edge logs. Opt-out tokens deliberately do
  *not* burn, so a second click still works.
- **Stage columns never appear in the upsert's `SET` list.** A returning client must not be
  demoted to `lead_in` and re-enter nurture.
- Business tables never belong in database `n8n` — see `vault/secrets.md`.
- SMTP egress is 465-only and public-ranges-only; a mail node that hangs is a policy drop or
  an SSL/TLS toggle left off — see `vault/secrets.md`.

## Verified

Against the live instance (n8n 2.16.1) and database on 2026-09-03. All statements run in
a transaction and rolled back:

- upsert is idempotent **and** preserves `commercial_stage`, `calendar_stage`,
  `touch_number`, `stopped_at`, `phone_norm` on a second submission
- mutation check: adding `commercial_stage = EXCLUDED.commercial_stage` to the upsert
  flips the stage assertion to false while `count(*) = 1` stays true — i.e. a row-count
  test alone would not have caught it
- `payment_pending` + `consult_booked` coexist
- normal token single-use; expired token rejected; opt-out token survives re-click
- a lead with `stopped_at` set is not selected for follow-up
- commas and apostrophes survive intact through the JSON parameter path
