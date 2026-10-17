# Reelsmith Social Publish

Reelsmith exports clips and a `manifest.csv` per job on the Mac. Syncthing copies the export
folder into the cluster PVC. Every 15 minutes an n8n dispatcher picks at most one due clip and
asks the `tiktok-sidecar` to post it. The sidecar is the gatekeeper: it reads the clip itself,
refuses anything unsafe or already posted, and uploads it to TikTok as a public post. Outcomes
land in `results.log.csv` and the ledger; problems alert on Telegram. YouTube posting is dropped.

Decision record: [ADR-0002](../../docs/decisions/0002-reelsmith-posting-gatekeeper.md), which
points to Reelsmith's ADR-012.

## Flow

```
Schedule (*/15 12-20 * * *, Africa/Johannesburg) → Pick Due Clip → TikTok Sidecar Upload → Log Results → Archive Manifest
```

- **Slots:** 12:00, 15:00 and 18:00 SAST. A run posts only when a slot has passed, is unused
  today, and at least 170 minutes have gone by since the last slot was claimed. The last tick is
  20:45, so nothing catches up after 21:00. At most 3 posts per SAST day; the sidecar enforces
  the same cap (`DAILY_CAP`).
- **Candidates:** manifests under the inbox modified on or after **2026-10-11** (the cutoff),
  newest job first, then manifest row order.
- **YouTube-sourced jobs only.** If a manifest has a `source` column, the row must say
  `youtube` (an empty cell is accepted only for an allowlisted job; any other value is skipped). A manifest without one (the backlog) qualifies only if its job id is in the legacy
  allowlist `YOUTUBE_LEGACY_JOBS` in `scripts/pick-due-clip.jsCode.js` (5 jobs). Everything else,
  TikTok-sourced jobs included, is skipped and never archived.
- **Missing file = wait** (Syncthing may still be copying it). **Junk** (empty filename, not
  `.mp4`, 1 KB or less) is skipped.
- **No video bytes pass through n8n.** n8n sends `clip_path` = `<job>/<filename>`. The sidecar
  mounts the PVC's `reelsmith-inbox` folder read-only at `/inbox` (subPath, so Syncthing's keys
  and config at the PVC root stay invisible) and reads `/inbox/<job>/<filename>` itself.
- **The sidecar decides** (image `0.2.0`, code in the `tiktok-sidecar` repo, which documents the
  n8n contract):
  - it validates the path and the file;
  - it keeps a ledger (`ledger.jsonl` on the cookies PVC) and refuses a clip already posted, by
    name or by content hash (409);
  - it enforces the daily cap (429), at most 6 upload attempts a day, and a 12h pause after 2
    failures in a row;
  - it holds the **kill switch** `POSTING_ENABLED`, which stays `false` until go-live step 7.
    While it is off, every request is a dry run.
- **Log Results** records each outcome in `results.log.csv` and the claim files, then alerts on
  Telegram when you are needed (cookie expired: clips wait and retry every 15 min; bad input: that clip is set aside and the next takes its slot; an upload that may or may not have
  posted). **Archive Manifest** moves a manifest once every row is posted or junk.

## Where things live

| Piece | Location |
|---|---|
| Workflow export | `workflow/reelsmith-social-publish.json`, built by `scripts/build-workflow.js` from the `scripts/*.jsCode.js` files |
| Workflow deploy | `scripts/deploy-workflow.sh` (n8n API; never automatic) |
| Kubernetes manifests | `manifests/`, synced by ArgoCD |
| One-off TEST_ALERT Job | `manifests/test/`, applied by hand, never synced |
| ArgoCD Application | `homelab-infra/argocd/applications/reelsmith-social-publish.yaml`: **manual sync**, a non-recursive directory source on `manifests/`. Merging here deploys nothing until you sync |
| Sidecar code and image | `tiktok-sidecar` repo, image `localhost:32000/reelsmith/tiktok-sidecar:0.2.0` |
| Self-checks | `cd scripts && npm ci && npm run selfcheck` (dispatcher); `bash scripts/watchdog.selftest.sh` (watchdog) |

### Manifests

| File | What |
|---|---|
| `pvc-reelsmith-inbox.yaml` | Syncthing's PVC (`syncthing-reelsmith-pvc`); n8n mounts it at `/data/reelsmith-inbox`, the sidecar mounts its `reelsmith-inbox` folder at `/inbox` |
| `syncthing-deployment.yaml`, `syncthing-networkpolicy.yaml` | Syncthing receiver (NodePort 32200) |
| `tiktok-sidecar-deployment.yaml` | the gatekeeper; settings are env vars (`POSTING_ENABLED`, `DAILY_CAP`, `ATTEMPT_CAP`, `MAX_CLIP_MB`, `INBOX_DIR`, `LEDGER_PATH`) |
| `tiktok-sidecar-service.yaml`, `tiktok-sidecar-pvc.yaml` | Service on 8000; cookies and ledger PVC |
| `tiktok-sidecar-networkpolicy.yaml` | ingress to the sidecar from n8n, the n8n worker and the watchdog; egress from n8n to the sidecar |
| `reelsmith-watchdog-cronjob.yaml`, `reelsmith-watchdog-networkpolicy.yaml` | the watchdog (below) and its path to Postgres |
| `external-secret-telegram.yaml` | Telegram alert credentials |
| `external-secret-youtube.yaml` | unused since YouTube was dropped; removal is deferred |
| `tiktok-sidecar-cookies-secret.yaml.example` | template only (ArgoCD reads only `.yaml`, `.yml` and `.json`) |

## Secrets (names only; values never in git)

| Secret in `n8n-live` | Keys | Source | Used by |
|---|---|---|---|
| `reelsmith-telegram` | `bot_token`, `chat_id` | ESO from Vault `kv/secret/n8n/live/reelsmith-telegram` | n8n (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` via `values-live.yaml`), the watchdog |
| `tiktok-sidecar-cookies` | `tiktok_session-reelsmith.cookie` | out-of-band, written by `make refresh-cookies` | the sidecar's init container copies it onto the cookies PVC |
| `reelsmith-watchdog-db` | `password` | out-of-band; recipe in the CronJob header | the watchdog (role `n8n_watchdog`, SELECT on `execution_entity` only) |
| `reelsmith-youtube` | `client_id`, `client_secret` | ESO | nothing (removal deferred) |
| n8n API key | none in the cluster | created in the n8n UI for one deploy, shortest expiry, typed on stdin to `deploy-workflow.sh`, deleted after go-live | deploys only |

## Refresh the TikTok cookie

The session cookie expires every few weeks. When n8n or the watchdog says
"cookie expired - run make refresh-cookies", run this from the `tiktok-sidecar` repo:

```bash
make refresh-cookies
```

You log in in the browser it opens. The script then:

1. checks the new cookie;
2. replaces the `tiktok-sidecar-cookies` Secret over `ssh` stdin, so the cookie never
   appears in argv or in a `last-applied` annotation;
3. restarts the sidecar and probes `/healthz/session`.

## The watchdog

The CronJob `reelsmith-publish-watchdog` runs at 12:45, 15:45, 18:45 and 20:45 SAST (the
CronJob has `timeZone: Africa/Johannesburg`) and sends at most one Telegram message per run:

- **Every run:** failed executions (`error`/`crashed`) of the workflow in the last 4h. The 12:45
  run looks back 17h, so a failure after the previous evening's 20:45 run is not missed.
- **12:45 run only, one combined message:** session probe 401 ("cookie expired - run make
  refresh-cookies"); the sidecar down or its probe failing; no successful post for over 48h, none
  on record, or posting paused; no executions at all in 25h.

Messages carry only fixed text, validated integers and the workflow id. A failed send exits 1 and
prints only the HTTP status. The CronJob ships **suspended** and is switched on at go-live step 8.
`bash scripts/watchdog.selftest.sh` runs the script against stub `psql`/`wget` and checks every
decision.

## Deploy

1. **Manifests.** Merge the PR, review the diff (`argocd app diff reelsmith-social-publish`
   or the ArgoCD UI), then sync the `reelsmith-social-publish` Application. If the `argocd` CLI
   on the node is not logged in, use the `.operation` patch in `docs/runbook.md` §4 with this
   app name. Before a sync that raises memory, check the namespace quota has room:
   `ssh homelab 'microk8s kubectl -n n8n-live describe resourcequota'`.
2. **Workflow.** Run `scripts/deploy-workflow.sh`. It reaches the n8n API through an SSH port
   forward and reads the API key on stdin. It saves the live copy (mode 0600) in the gitignored
   `backups/`, then updates the workflow in place and publishes it (`--live` only; dry runs use `--no-publish`).
3. **The inbox mount on n8n** (`/data/reelsmith-inbox` on the main and worker pods) comes from
   `values-live.yaml`. Change it through a PR and an `n8n-live` sync (`docs/runbook.md` §4),
   never with Helm.

## Mac setup

1. Set `YTVIDEO_EXPORT_BASE_FOLDER` in Reelsmith `.env` to your local Syncthing share folder
   (for example `~/Sync/reelsmith-inbox`).
2. In the Syncthing web UI on the Mac:
   - add the homelab Syncthing as a remote device via `<node-ip>:32200`;
   - share the folder targeting `/var/syncthing/reelsmith-inbox` on the cluster side;
   - set the Mac folder to **Send Only** and the cluster side to **Receive Only**;
   - add a `.stignore` with `*.tmp`, `.DS_Store` and `processed/`.
3. New clips reach the cluster only while the Mac is awake with Tailscale up, and nothing posts
   while the homelab is off. Keep it on from 11:30 to 21:00 SAST.

## Go-live runbook

Paste the evidence at each step; nothing moves to the next step without your go.

1. **Spike (read-only), in the current sidecar pod.** Probe with the real cookie and with a bogus
   `sessionid`. Print only the HTTP status and whether `video_token_v5` is in the body.
2. **Merge the sidecar PR**, then `make remote-ship TAG=0.2.0` in `tiktok-sidecar`. Run a
   signature smoke test in a throwaway 0.2.0 container
   (`node tiktok-signature/browser.js <url> <ua>`, no cookie).
3. **Merge this PR**, review `argocd app diff reelsmith-social-publish`, then sync it. Check:
   - the image is 0.2.0, `/inbox` is mounted, `POSTING_ENABLED=false`;
   - `/healthz`, `/healthz/session?account=reelsmith` and `/api/stats?account=reelsmith` answer.
     From the Mac:
     `ssh -L 18000:127.0.0.1:18000 homelab 'microk8s kubectl -n n8n-live port-forward svc/tiktok-sidecar 18000:8000'`,
     then `curl -s localhost:18000/healthz`;
   - the watchdog is suspended:
     `ssh homelab 'microk8s kubectl -n n8n-live get cronjob reelsmith-publish-watchdog -o jsonpath={.spec.suspend}'`
     prints `true`.
4. **`make refresh-cookies`, once, regardless.** You log in; the probe says valid.
5. **Dry run.** Save it unpublished: `deploy-workflow.sh --workflow-id ID --dry-run --no-publish` (n8n API key on
   stdin, shortest expiry), then execute it once by hand from the n8n editor (never published: no 36 dry runs a day). Check:
   - the newest **YouTube** clip is picked (job `1979f8a4`), and no TikTok-sourced job is
     touched;
   - a `dry_run` ledger row appears, and the claim and slot are released;
   - `fs` and `DateTime` work in the n8n 2.39.8 runner;
   - **no TikTok post** appears.
6. **Forced-failure dry run.** `deploy-workflow.sh --workflow-id ID --dry-run --simulate auth_invalid --no-publish`, executed by hand (`simulate` is honoured only in
   dry runs) and confirm the 401 Telegram alert arrives.
7. **Your go.** Record your Phase 0 gate answers first (account status, For You eligibility,
   clickable tags). Then a manifest PR sets `POSTING_ENABLED` to `"true"`; merge it and sync.
   Deploy the workflow live with `deploy-workflow.sh --workflow-id ID --live`, the only step that publishes.
8. **First real post** at the next slot. In an incognito window, check it's public, with the full
   caption and at most 5 clickable tags, and the ledger row says `posted`. Then:
   - a manifest PR sets the watchdog's `suspend: false` and pins its image by digest; merge it
     and sync;
   - run the TEST_ALERT Job once:
     `ssh homelab 'microk8s kubectl create -f -' < manifests/test/reelsmith-watchdog-test-alert-job.yaml`.
     One test message must arrive.
9. **Observe for 2 days:**
   - at most 3 posts per SAST day, one per slot, newest first;
   - no duplicates; missing clips are waited for; junk is skipped;
   - no `OOMKilled` or `Error` in the sidecar's `lastState`;
   - the watchdog stays quiet;
   - run the largest clip as a dry run to measure peak memory.
10. **Rollback:**
    - run `deploy-workflow.sh --deactivate` first. Never PUT the old copy while it is
      published.
    - set `POSTING_ENABLED` back to `"false"` and sync, or `git revert` this PR and sync.

    The saved copy's path is recorded in the session log. While the workflow stays off, set the
    watchdog back to `suspend: true` in the same PR; otherwise it reports "no executions in 25h"
    every day.

If n8n alerts that an upload is **ambiguous** (it may or may not have posted), check the account,
then run `make ledger-resolve KEY=<clip_key> OUTCOME=posted|not_posted` in `tiktok-sidecar`.
