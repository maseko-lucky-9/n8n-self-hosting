# Reelsmith Social Publish

Reelsmith exports clips and a `manifest.csv` per job on the Mac. Syncthing copies the export
folder into the cluster PVC. Every 15 minutes an n8n dispatcher picks at most one due clip and
asks the `tiktok-sidecar` to post it. The sidecar is the gatekeeper: it reads the clip itself,
refuses anything unsafe or already posted, and uploads it to TikTok as **Only me** (private). You make
each one public yourself in TikTok Studio; a Telegram notice says when a clip is waiting. Outcomes
land in `results.log.csv` and the ledger; problems alert on Telegram. YouTube posting is dropped.

Decision records: [ADR-0002](../../docs/decisions/0002-reelsmith-posting-gatekeeper.md), which
points to Reelsmith's ADR-012, and [ADR-0003](../../docs/decisions/0003-reelsmith-private-uploads.md)
(uploads are Only me).

## Flow

```
Schedule (*/15 12-20 * * *, Africa/Johannesburg) → Pick Due Clip → TikTok Sidecar Upload → Log Results → Archive Manifest
```

- **Slots:** 12:00, 15:00 and 18:00 SAST. A run posts only when a slot has passed, is unused
  today, and at least 170 minutes have gone by since the last slot was claimed. The last tick is
  20:45, so nothing catches up after 21:00. At most 3 posts per SAST day; the sidecar enforces
  the same cap (`DAILY_CAP`).
- **Candidates:** manifests under the inbox modified on or after **2026-10-11** (the cutoff),
  taken in turns across source videos (a job is one video): never the same video twice in a row; a
  video holding more than half of all ready clips goes every other post; otherwise the video used
  least recently (its newest claim that may have reached TikTok: `posted`, `failed`, in flight, or an
  old marker; `needs_you` and `posted_elsewhere` do not count); ties keep the newest manifest first.
  Within a video, manifest row order. **A video's intro is never posted**: a clip whose filename
  starts with `00_` or whose title is "Intro". It is skipped silently (no notice) and does not stop
  its manifest from archiving.
- **YouTube-sourced jobs only.** If a manifest has a `source` column, the row must say
  `youtube` (an empty cell is accepted only for an allowlisted job; any other value is skipped). A manifest without one (the backlog) qualifies only if its job id is in the legacy
  allowlist `YOUTUBE_LEGACY_JOBS` in `scripts/pick-due-clip.jsCode.js` (5 jobs). Everything else,
  TikTok-sourced jobs included, is skipped and never archived.
- **Missing file = wait** (Syncthing may still be copying it). **Ordinary junk** (empty
  filename, not `.mp4`, 1 KB or less) is skipped and does not hold up archiving.
- **A clip that can never be posted as it is** is skipped too, but reported and never archived
  away: a name over 200 bytes or one the sidecar refuses (only letters, digits, `_`, `.`, `-` and
  space, ending in `.mp4`), a file over 300 MiB, no usable caption (nothing left of the
  description or the title once URLs, `@`, `#` and emoji are stripped), or not a regular file.
  - Reported three ways: listed (job, row, reason) in `/data/reelsmith-inbox/.state/notices.json`;
    counted in a once-a-day Telegram notice from a run that posts; and, when nothing else can be
    posted, by one failed execution a day, which the watchdog reports. Read the list with
    `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- cat /data/reelsmith-inbox/.state/notices.json'`.
  - It pins its manifest: Archive Manifest keeps the manifest until you fix the clip (re-export
    it so it passes) or archive the manifest by hand, which also skips its remaining clips:
    `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- sh -c "cd /data/reelsmith-inbox/reelsmith-inbox/<job> && mkdir -p processed && mv manifest.csv processed/manifest-by-hand.csv"'`.
- **No video bytes pass through n8n.** n8n sends `clip_path` = `<job>/<filename>`. The sidecar
  mounts the PVC's `reelsmith-inbox` folder read-only at `/inbox` (subPath, so Syncthing's keys
  and config at the PVC root stay invisible) and reads `/inbox/<job>/<filename>` itself.
- **The sidecar decides** (image `0.4.0`, code in the `tiktok-sidecar` repo, which documents the
  n8n contract):
  - it validates the path and the file;
  - it keeps a ledger (`ledger.jsonl` on the cookies PVC) and refuses a clip already posted, by
    name or by content hash (409);
  - it enforces the daily cap (429), at most 6 upload attempts a day, and a 12h pause after 2
    failures in a row;
  - it holds the **kill switch** `POSTING_ENABLED`, `false` until go-live step 7 and `"true"` after it.
    While it is off, every request is a dry run.
- **Log Results** records each outcome in `results.log.csv` and the claim files, then alerts on
  Telegram when you are needed (cookie expired: clips wait and retry every 15 min; bad input: that clip is set aside and the next takes its slot; an upload that may or may not have
  posted). If the workflow is live while the sidecar's `POSTING_ENABLED` is `false`, every clip
  is released and retried, and a once-a-day Telegram notice says so. **Archive Manifest** moves a
  manifest once every row is posted or ordinary junk.

## Where things live

| Piece | Location |
|---|---|
| Workflow export | `workflow/reelsmith-social-publish.json`, built by `scripts/build-workflow.js` from the `scripts/*.jsCode.js` files |
| Workflow deploy | `scripts/deploy-workflow.sh` (n8n API; never automatic) |
| Kubernetes manifests | `manifests/`, synced by ArgoCD |
| One-off TEST_ALERT Job | `manifests/test/`, applied by hand, never synced |
| ArgoCD Application | `homelab-infra/argocd/applications/reelsmith-social-publish.yaml`: **manual sync**, a non-recursive directory source on `manifests/`. Merging here deploys nothing until you sync |
| Sidecar code and image | `tiktok-sidecar` repo, image `localhost:32000/reelsmith/tiktok-sidecar:0.4.0`, deployed by digest |
| Self-checks | `cd scripts && npm ci && npm run selfcheck` (dispatcher); `bash scripts/watchdog.selftest.sh` (watchdog); from the repo root, `bash scripts/disclosure-sweep.selftest.sh` (disclosure sweep) |

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

- **Every run:** failed executions (`error`, `crashed` or `canceled`; an execution timeout may
  be recorded as canceled) of the workflow in the last 4h. The 12:45 run looks back 17h, so a
  failure after the previous evening's 20:45 run is not missed.
- **12:45 run only, one combined message:**
  - the session probe: 401 is "cookie expired - run make refresh-cookies"; 502 is "sidecar
    cannot reach TikTok"; 503 is "no cookie on the sidecar"; no answer is "sidecar down"; any
    other status is "sidecar session check failed";
  - `/api/stats`: any non-200 is "sidecar down"; also no successful post for over 48h, none on
    record, or posting paused;
  - no executions at all in 25h.

Messages carry only fixed text, validated integers and the workflow id. A failed send exits 1 and
prints only the HTTP status. The CronJob was switched on 2026-10-24 (it shipped suspended until the first upload).
`bash scripts/watchdog.selftest.sh` runs the script against stub `psql`/`wget` and checks every
decision.

## Deploy

1. **Manifests.** Merge the PR, review the diff (`argocd app diff reelsmith-social-publish`
   or the ArgoCD UI), then sync the `reelsmith-social-publish` Application. If the `argocd` CLI
   on the node is not logged in, use the `.operation` patch in `docs/runbook.md` §4 with this
   app name. Before a sync that raises memory, check the namespace quota has room:
   `ssh homelab 'microk8s kubectl -n n8n-live describe resourcequota'`.
2. **Workflow.** Run `scripts/deploy-workflow.sh --workflow-id <ID>` with `--dry-run`, `--live`
   or `--deactivate` (the ID is the one in the n8n editor URL). It reaches the n8n API through
   an SSH port forward and reads the API key on stdin. It saves the live copy (mode 0600) in
   the gitignored `backups/`, then updates the workflow in place. A `--dry-run` deploy is saved
   only and never published (you execute it by hand from the editor); `--live` saves and
   publishes; `--deactivate` unpublishes.
   - It connects as `svc-ai-agent` through the ssh alias `homelab-tunnel` (override with
     `N8N_SSH_HOST`): sshd allows port forwarding only for that user, so the usual `homelab`
     alias (user `dev`) fails with "administratively prohibited".
   - The remote port-forward runs as its own process group and is killed as a group when the
     script ends, so nothing is left holding the port. A run that stops with "address already in
     use" means a stale port-forward from an older run still holds `127.0.0.1:15678` on the
     homelab (this should no longer happen): stop that process, or pick another port with
     `N8N_FORWARD_PORT`.
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
   - **Deploy the sidecar image by digest, not by tag.** The in-cluster registry
     (`localhost:32000`, NodePort 32000) has no auth, so any pod that can reach it could push a
     poisoned `:0.2.0`.
     - Read the pushed digest: `docker push` prints `0.2.0: digest: sha256:<digest> size: …`
       at the end of `make remote-ship`. Or, on the homelab, run
       `ssh homelab "docker inspect --format '{{index .RepoDigests 0}}' localhost:32000/reelsmith/tiktok-sidecar:0.2.0"`.
     - In a follow-up PR to this one (the PR-B follow-up), change the `image:` line in
       `manifests/tiktok-sidecar-deployment.yaml` to
       `localhost:32000/reelsmith/tiktok-sidecar@sha256:<digest>`, and merge it before step 3's
       sync.
     - Done: 0.2.0 on 2026-10-18; now `sha256:0f0cddada0abb51c4fe6126c645088bdd49ac5ecc125bc302debbb7a56a045be` (0.3.1: Only-me uploads, and the uploader ignores TikTok's 404 on its warm-up HEAD), built from `tiktok-sidecar` `87a9c4e` on 2026-10-24 and checked inside the image: both patches present once, the public line zero times. 0.2.0 was confirmed against
       the registry's `Docker-Content-Digest`. The follow-up PR carries the `image:` change.
3. **Merge this PR**, review `argocd app diff reelsmith-social-publish`, then sync it.
   - Before the sync, confirm root owns the cookies folder. The new seed-cookies init container
     runs with no capabilities, so it cannot write a folder another uid owns:
     `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/tiktok-sidecar -- stat -c "%u:%g %a" /app/CookiesDir'`
     must print `0:0` and a mode. Otherwise, chown it to root first, or the new pod stays in
     `Init` (and the old one is already gone: the Deployment uses Recreate).
   - Before step 5 writes any claim, add a **cluster-side** Syncthing ignore file. Claims,
     `results.log.csv` and `processed/` live inside the receive-only synced folder, so Syncthing
     lists them as local changes:
     `printf '%s\n' .claims results.log.csv processed | ssh homelab 'microk8s kubectl -n n8n-live exec -i deploy/syncthing -- sh -c "cat > /var/syncthing/reelsmith-inbox/.stignore"'`.
     Check the folder's Ignore Patterns in the cluster Syncthing UI. **Never click "Revert Local
     Changes"** on the cluster side: it deletes every claim, the results logs and the archived
     manifests, so posted clips would be posted again.

   After the sync, check:
   - the image is `localhost:32000/reelsmith/tiktok-sidecar@sha256:<digest>` from step 2,
     `/inbox` is mounted, and `POSTING_ENABLED=false`;
   - `/healthz`, `/healthz/session?account=reelsmith` and `/api/stats?account=reelsmith` answer.
     From the Mac:
     `ssh -L 18000:127.0.0.1:18000 homelab 'microk8s kubectl -n n8n-live port-forward svc/tiktok-sidecar 18000:8000'`,
     then `curl -s localhost:18000/healthz`;
   - the watchdog is suspended:
     `ssh homelab 'microk8s kubectl -n n8n-live get cronjob reelsmith-publish-watchdog -o jsonpath={.spec.suspend}'`
     prints `true`.
4. **`make refresh-cookies`, once, regardless.** You log in; the probe says valid.
5. **Dry run.** `scripts/deploy-workflow.sh --workflow-id <ID> --dry-run` (n8n API key on
   stdin, shortest expiry; it connects as `homelab-tunnel`, see Deploy step 2). A dry-run
   deploy is saved, never published, so it does not run 36 times a day; execute it once by
   hand from the n8n editor. Check:
   - a **YouTube** clip is picked (historically the newest, job `1979f8a4`; see Candidates for the rotation now), and no TikTok-sourced job is
     touched;
   - a `dry_run` row appears in `ledger.dryrun.jsonl`, the separate, size-capped dry-run log
     next to the ledger; the posting ledger `ledger.jsonl` is unchanged; the claim and slot are
     released;
   - `fs` and `DateTime` work in the n8n 2.39.8 runner;
   - **no TikTok post** appears.
6. **Forced-failure dry run.** `scripts/deploy-workflow.sh --workflow-id <ID> --dry-run --simulate auth_invalid` (via `homelab-tunnel`),
   executed by hand from the editor (`simulate` is honoured only in dry runs). Confirm the 401
   Telegram alert arrives.
7. **Your go.** Record your Phase 0 gate answers first (account status, For You eligibility,
   clickable tags). Then a manifest PR sets `POSTING_ENABLED` to `"true"`; merge it and sync.
   Deploy the workflow live with `scripts/deploy-workflow.sh --workflow-id <ID> --live` (via
   `homelab-tunnel`), the only deploy that publishes.
8. **First real upload** at the next slot. A Telegram "uploaded as Only me" notice arrives. In an
   incognito window the post must **not** be visible; in TikTok Studio it shows as Only me with the
   full caption and at most 5 clickable tags, and the ledger row says `posted`. Set it to Everyone
   when you are ready. Then:
   - a manifest PR sets the watchdog's `suspend: false` and pins its image by digest; merge it
     and sync;
   - run the TEST_ALERT Job once:
     `ssh homelab 'microk8s kubectl create -f -' < manifests/test/reelsmith-watchdog-test-alert-job.yaml`.
     One test message must arrive.
9. **Observe for 2 days:**
   - at most 3 posts per SAST day, one per slot, consecutive posts from different videos, no `00_` intro;
   - no duplicates; missing clips are waited for; junk is skipped;
   - no `OOMKilled` or `Error` in the sidecar's `lastState`;
   - the watchdog stays quiet;
   - run the largest clip as a dry run to measure peak memory.
10. **Rollback:**
    - run `scripts/deploy-workflow.sh --workflow-id <ID> --deactivate` first (it connects as
      `homelab-tunnel`, like every deploy). Never PUT the old
      copy while it is published.
    - set `POSTING_ENABLED` back to `"false"` and sync, or `git revert` this PR and sync.

    The saved copy's path is recorded in the session log. While the workflow stays off, set the
    watchdog back to `suspend: true` in the same PR; otherwise it reports "no executions in 25h"
    every day.

## When a clip is set aside

A clip with an unclear or refused outcome keeps its n8n claim, so it is never retried and its
manifest is never archived. The Telegram alert prints the exact commands for that clip.

- **Ambiguous upload** (it may or may not have posted), or a clip **blocked** by an earlier
  unresolved upload (409 `ambiguous`):
  1. check the account, then in `tiktok-sidecar` run the line that matches:
     `make ledger-resolve KEY='<job>/<filename>' OUTCOME=posted`
     `make ledger-resolve KEY='<job>/<filename>' OUTCOME=not_posted`
     Keep the single quotes: clip names contain spaces, and an unquoted `KEY` splits at the first
     one. Here `<filename>` is the clip's file name including `.mp4`.
     - If it is refused with "no ledger rows for that clip_key" or "...; it is free", the upload
       never reached TikTok (a 502 rejection, a failed 500, or a reset or timeout before the
       sidecar wrote its row). There is nothing to resolve: go to step 2.
  2. then, **in every case**, release the n8n claim:
     `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- rm "/data/reelsmith-inbox/reelsmith-inbox/<job>/.claims/<filename>.json"'`.
     - After `not_posted`, or when the key was free, the clip is uploaded again at a later slot.
     - After `posted`, the retry gets a 409 `duplicate` from the sidecar and is logged as
       `posted_elsewhere`. That frees the slot, posts nothing, and lets the manifest archive.
     - A claim left in place keeps its `failed` status, so the manifest never archives.
     - If the ledger says ambiguous, resolve it first: releasing the claim alone only produces
       another ambiguous 409.
- **Refused clip** (400 bad input or 413 too large): fix or re-export the clip, then release the
  claim with the same command. Or leave it set aside.

## Run as non-root (sidecar 0.4.0)

The image runs as uid/gid 10001 under tini. The Deployment pins `runAsUser`, `runAsGroup` and
`fsGroup` to 10001, and the cookie Secret is mode 0440 so that group can read it. `fsGroup` does
not change the ownership of the hostpath cookies PVC, so its existing files were handed over once:

```bash
ssh homelab 'microk8s kubectl create -f -' < manifests/test/tiktok-sidecar-chown-cookies-job.yaml
```

Run it immediately before the sync that rolls out the non-root Deployment (the old root pod has
no capabilities and cannot open files that 10001 owns). It is safe to re-run. To go back to root,
revert the Deployment change and sync: root can still read files owned by 10001 only with
`DAC_OVERRIDE`, so run the same Job with `chown -R 0:0` first.

## Known limits

- The watchdog's Telegram token is visible to anyone with a shell on the node: busybox `wget`
  takes it in its argv, which `/proc/<pid>/cmdline` exposes for the few seconds of the call
  (the environment is not exposed that way). This is accepted on this single-user node. The fix
  is an image that ships `curl` (token on stdin); installing it at runtime is what made the old
  watchdog miss its deadline, so it is deferred.
- The once-a-day checks run only at 12:45. If the homelab is off then, that day's checks are
  skipped; failed executions are still reported on the later runs.
- The web uploader returns no TikTok post id, so the ledger's `posted` row is the record.
- The Only-me notice is informational: if Telegram is down when a clip uploads, the notice is lost
  (the ledger and TikTok Studio still show the clip).
- **Failed uploads leave a tail.** The sidecar appends the redacted uploader output of every run
  that did not post to `ledger.failures.jsonl` on the cookies PVC (survives restarts). Read it:
  `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/tiktok-sidecar -c tiktok-sidecar -- tail -n 5 /app/CookiesDir/ledger.failures.jsonl'`.

## Known hardening deferred

- Every image is pinned by digest (the sidecar from go-live step 2; busybox, syncthing and postgres by their multi-arch index digest).
- The sidecar's egress is limited by `tiktok-sidecar-egress`: cluster DNS and public 80/443 only, no private ranges.
- The sidecar API has no bearer auth; NetworkPolicy is the only gate (Phase 3).

## Owner actions (repository and host settings, not code)

- **Fork pull requests.** This repository is public and its self-hosted runner holds cluster
  credentials. For `pull_request` events, GitHub runs the workflow files from the PR's own
  merge ref, so a fork PR can bring its own workflow that targets the self-hosted runner. The
  `runs-on` value in this repo's workflows does not prevent that. Set Actions > General >
  "Require approval for all external contributors", and/or detach the self-hosted runner from
  this repository.
- Enable secret scanning and push protection, and protect `main`.
- **The in-cluster image registry has no auth.** The microk8s registry (`localhost:32000`,
  NodePort 32000) is reachable from pods, and nothing authenticates a push, so any pod could
  replace a tag. Deploying by digest (go-live step 2) protects the sidecar. To close the hole
  itself, restrict who can reach the registry or put auth in front of it.
