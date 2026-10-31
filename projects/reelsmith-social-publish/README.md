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

- **Slots:** 12:00, 15:00 and 18:00 SAST: at most 3 uploads a day, the owner's policy (the
  owner's understanding of TikTok's limit, not a documented TikTok number; ADR-0002, second
  2026-10-31 amendment). A run posts only when a slot has passed, is unused today, and at least
  160 minutes have gone by since the last slot was claimed (runs fall on the quarter hour, so a
  late slot catches up 15 minutes per slot). The last tick is 20:45, so nothing catches up after
  21:00. The sidecar enforces the same cap (`DAILY_CAP` 3). Each slot leaves a marker named by
  its position, `.slots/<day>-<i>.json` (0 = 12:00, 1 = 15:00, 2 = 18:00): never reorder
  `SLOTS` in `scripts/pick-due-clip.jsCode.js`, or a deploy reads today's markers as other slots.
- **Candidates:** manifests under the inbox modified on or after **2026-10-11** (the cutoff),
  taken in turns across source videos (a job is one video): never the same video twice in a row; a
  video holding more than half of all ready clips goes every other post; otherwise the video used
  least recently (its newest claim that may have reached TikTok: `posted`, `failed`, in flight, or an
  old marker; `needs_you` and `posted_elsewhere` do not count); ties keep the newest manifest first.
  Within a video, manifest row order. **A video's intro is never posted**: a clip whose filename
  starts with `00_` or whose title is "Intro". It is skipped silently (no notice) and does not stop
  its manifest from archiving, even if an old claim on it never resolved.
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
    counted in a once-a-day Telegram notice from a run that posts (only when `NOTIFY_INFO` is on,
    see Telegram messages); and, when nothing else can be posted, by one failed execution a day,
    which the watchdog reports (every run checks for failed executions). Read the list with
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
  - it enforces the daily cap (429), at most 6 upload attempts a day (`ATTEMPT_CAP`, 2 per
    slot), and a 12h pause after 2 failures in a row;
  - it holds the **kill switch** `POSTING_ENABLED`, `false` until go-live step 7 and `"true"` after it.
    While it is off, every request is a dry run.
- **Log Results** records each outcome in `results.log.csv` and the claim files, then alerts on
  Telegram when you are needed (cookie expired: clips wait and retry every 15 min; bad input: that clip is set aside and the next takes its slot; TikTok refused to publish it:
  the slot stays used and the clip is retried once, after another clip, at a later slot, then set aside at its 2nd
  refusal (a short notice for the 1st, an alert for the 2nd); TikTok throttling or a signing failure: the clip
  is retried at a later slot; an upload that may or may not have posted). If the workflow is live while the sidecar's `POSTING_ENABLED` is `false`, every clip
  is released and retried, and a once-a-day Telegram notice says so. When the sidecar's daily cap
  is reached (429, e.g. after a manual upload that day), the clip waits for tomorrow, the slot stays
  used, and a once-a-day notice says so. Which of these reach Telegram with the shipped gates:
  [Telegram messages](#telegram-messages). **Archive Manifest** moves a
  manifest once every row is posted or ordinary junk.

## Where things live

| Piece | Location |
|---|---|
| Workflow export | `workflow/reelsmith-social-publish.json`, built by `scripts/build-workflow.js` from the `scripts/*.jsCode.js` files |
| Workflow deploy | `scripts/deploy-workflow.sh` (n8n API; never automatic) |
| Kubernetes manifests | `manifests/`, synced by ArgoCD |
| One-off test objects (TEST_ALERT Job, cookies chown Job, the `ReelsmithDrill` rule) | `manifests/test/`, applied by hand, never synced |
| ArgoCD Application | `homelab-infra/argocd/applications/reelsmith-social-publish.yaml`: **manual sync**, a non-recursive directory source on `manifests/`. Merging here deploys nothing until you sync |
| Sidecar code and image | `tiktok-sidecar` repo, image `localhost:32000/reelsmith/tiktok-sidecar:0.5.0`, deployed by digest |
| Alert rules | `manifests/reelsmith-alerts-prometheusrule.yaml` ([Alerts](#alerts)); promtool unit tests in `tests/` |
| Self-checks | `cd scripts && npm ci && npm run selfcheck` (dispatcher, manifests); `bash scripts/watchdog.selftest.sh` (watchdog); from the repo root, `bash scripts/disclosure-sweep.selftest.sh` (disclosure sweep) and `sh projects/reelsmith-social-publish/tests/run-promtool-tests.sh` (alert rules; needs docker and mikefarah yq v4) |

### Manifests

| File | What |
|---|---|
| `pvc-reelsmith-inbox.yaml` | Syncthing's PVC (`syncthing-reelsmith-pvc`); n8n mounts it at `/data/reelsmith-inbox`, the sidecar mounts its `reelsmith-inbox` folder at `/inbox` |
| `syncthing-deployment.yaml`, `syncthing-networkpolicy.yaml` | Syncthing receiver (NodePort 32200) |
| `tiktok-sidecar-deployment.yaml` | the gatekeeper; settings are env vars (`POSTING_ENABLED`, `DAILY_CAP`, `ATTEMPT_CAP`, `MAX_CLIP_MB`, `INBOX_DIR`, `LEDGER_PATH`) |
| `tiktok-sidecar-service.yaml`, `tiktok-sidecar-pvc.yaml` | Service on 8000 (API) and 9100 (metrics); cookies and ledger PVC |
| `tiktok-sidecar-networkpolicy.yaml` | ingress to the sidecar from n8n, the n8n worker and the watchdog on 8000, and from Prometheus on 9100 only; egress from n8n to the sidecar; the sidecar's own egress |
| `tiktok-sidecar-servicemonitor.yaml` | Prometheus scrapes the sidecar's `/metrics` on 9100 every 30 s (job `tiktok-sidecar`) |
| `reelsmith-alerts-prometheusrule.yaml` | the 11 Reelsmith alerts ([Alerts](#alerts)) |
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

## Telegram messages

The homelab desk (OpenClaw on the Mac) now watches the whole workflow and tells the owner about
real faults, so Log Results sends only what the desk cannot do or see (ADR-0002, amendment
2026-10-28), plus two messages the owner keeps on (second 2026-10-31 amendment). The gates are
constants in `scripts/log-results.jsCode.js`; shipped values: `NOTIFY_INFO = false`,
`NOTIFY_SESSION = true`, `NOTIFY_SIDECAR_DOWN = true`.

| Message | Sent |
|---|---|
| "uploaded as Only me, set it to Everyone" | always: the one manual step you must take |
| a clip refused as bad input (400) or too large (413) | always, with the commands to release it: the desk cannot see these |
| upload outcome unknown (a timeout or unexpected answer: it may have posted) | always, with the commands to check and release it: a clip may be on TikTok as Only me, and only you can check |
| "TikTok session invalid (N in a row). Run `make refresh-cookies` ..." (401 `auth_invalid`) | `NOTIFY_SESSION`: the 1st in a row, then every 12th (about every 3 h). The alert rules see a dead cookie only at the next session probe, so this is the fast path |
| "sidecar unavailable N times in a row; clips are waiting." for 503 `network_before_upload` (the sidecar cannot reach TikTok) or `clock_unsynced` | `NOTIFY_SIDECAR_DOWN`: the 3rd in a row, then every 12th. No alert rule sees either (requests still arrive, nothing is paused). N counts every unavailable answer in a row |
| the same message for any other unavailable answer (503 `busy` or `paused`, sidecar not answering) | only with `NOTIFY_INFO`: `ReelsmithSidecarDown` covers a sidecar that does not answer, `ReelsmithPaused` a pause; `busy` is another upload holding the lock |
| first TikTok refusal (retried later), set-aside after the 2nd refusal | only with `NOTIFY_INFO` |
| "posting too fast" / signing failure (deferred), a clip blocked by an earlier unknown upload | only with `NOTIFY_INFO` |
| daily cap reached, kill switch off while live, manifest problems | only with `NOTIFY_INFO` |

The two owner messages keep the wording and cadence of the workflow deployed on 2026-10-18;
`log-results.selfcheck.js` pins both. Only the outgoing message is gated: claims, slots, counters, refusal counts and result rows are
the same either way, and a gated message never fails the run (an always-sent message still does
when it cannot be sent, which the watchdog then reports). A once-a-day notice is marked sent only when it was sent, so it is not lost if
the flag is turned on later. To get every message again (for example while the desk is off), change
the constant to `true`, rebuild (`cd scripts && node build-workflow.js`) and redeploy the workflow.

## The watchdog

The CronJob `reelsmith-publish-watchdog` is the backstop for when the Mac is asleep and the desk
cannot reach you. It runs at 09:45, 12:45, 15:45, 18:45 and 21:45 SAST (the CronJob has
`timeZone: Africa/Johannesburg`) and sends at most one Telegram message per run. These are not
upload slots: 09:45 probes the session before the first slot (12:00), so a dead cookie is
reported before that slot spends an attempt on it; 12:45, 15:45 and 18:45 follow the slots;
21:45 follows the last dispatcher tick (20:45).

- **Every run:** failed executions (`error`, `crashed` or `canceled`; an execution timeout may
  be recorded as canceled) of the workflow in the last 4h. The 09:45 run looks back 13h (to
  20:45, the last tick), overlapping the 21:45 run, so nothing from the previous evening is
  missed. Nothing else in the cluster reads n8n's execution state, so this stays on every run.
- **09:45 run only, appended to the same message:** the session probe (the sidecar caches it):
  401 is "cookie expired - run make refresh-cookies"; 502 is "sidecar cannot reach TikTok"; 503 is
  "no cookie on the sidecar"; no answer is "sidecar down"; any other status is "sidecar session
  check failed".

Dropped on 2026-10-28, because the desk owns them: the `/api/stats` checks (no success for 48h,
none on record, posting paused, stats unreadable) and "no executions in 25h". Once the Reelsmith
alert rules are live (plan section A2), Alertmanager's critical alert for the sidecar is a second
backstop. For the session it is not independent: the 09:45 session probe is what lets
`ReelsmithSessionInvalid` see a dead cookie that is still on disk (see [Alerts](#alerts)).

Messages carry only fixed text, validated integers and the workflow id. A failed send exits 1 and
prints only the HTTP status. The CronJob was switched on 2026-10-24 (it shipped suspended until the first upload).
`bash scripts/watchdog.selftest.sh` runs the script against stub `psql`/`wget` and checks every
decision.

## Alerts

Since sidecar 0.5.0, Prometheus scrapes the sidecar's `GET /metrics` on its own port, 9100, every
30 s (`tiktok-sidecar-servicemonitor.yaml`). The metrics listener serves nothing else, and only
the Prometheus pod in `observability` may reach it, so the scrape never opens the upload API on
8000. The PrometheusRule `reelsmith-alerts` turns the metrics into 11 alerts. Critical ones page
Telegram through Alertmanager even while the Mac is asleep; warnings are for the homelab desk
(ADR-0002, amendment 2026-10-31). The desk allowlists these names exactly, so renaming or adding
one is a desk change too.

| Alert | Severity | Fires when |
|---|---|---|
| `ReelsmithSidecarDown` | critical | no successful scrape, or no target at all, for 5 min |
| `ReelsmithSessionInvalid` | critical | for 5 min: the session probe said invalid (`session_valid` 0), or the cookie file has no session (`cookie_present` 0), or an upload was refused as `auth_invalid` in the last hour. Fix: `make refresh-cookies` in tiktok-sidecar |
| `ReelsmithLedgerUnreadable` | critical | the ledger cannot be read for 5 min (every upload is refused) |
| `ReelsmithPostingDisabled` | warning | `POSTING_ENABLED` is not true for 15 min |
| `ReelsmithPaused` | warning | the failure pause or the attempt-cap pause is on for 5 min (one alert per `reason`) |
| `ReelsmithAmbiguousUpload` | warning | an upload outcome is unresolved for 5 min (`make ledger-resolve`) |
| `ReelsmithThrottled` | warning | TikTok said "posting too fast" in the last 30 min; stays up 2 h more |
| `ReelsmithDispatcherSilent` | warning | no `/api/upload` request for 3.5 h, 13:00-21:00 SAST, unless paused, posting off, or no clip ready. A healthy three-slot day stays under 3 h inside the window; a missed 15:00 or 18:00 slot fires at about 15:36 or 18:36, a missed 12:00 slot at 13:05 |
| `ReelsmithNoPostToday` | warning | nothing posted by 13:00 SAST (until 22:00), unless the daily attempt cap is used, posting off, a probe said the session is invalid, or no clip ready. The failures pause does **not** silence it |
| `ReelsmithClipsSetAside` | warning | a clip is set aside (`needs_you`) for 15 min |
| `ReelsmithBacklogLow` | warning | fewer than 10 clips ready to post for 1 h (about 3 days at 3 a day) |

- **The session: `ReelsmithSessionInvalid` is only as fast as the probe cadence.**
  `session_valid` is the latest probe: 1, 0, or -1 (unknown, after every restart and before any
  probe). Only 0 pages; -1 must not. A cookie that dies while its file is still on disk changes
  nothing the rule can see until a probe runs: `session_valid` keeps its last verdict,
  `cookie_present` stays 1, and the sidecar answers `auth_invalid` only when the cookie file is
  unusable, after a probe already said invalid, or when the uploader output looks like an auth
  failure and a fresh probe confirms it. TikTok's refusal of the publish request for a dead
  session (status code 7 on 2026-10-30) is classed `publish_rejected` and triggers no probe. After
  the sync the only routine probe is the watchdog's 09:45 SAST run, so **a cookie that dies just
  after it pages about 24 hours later, no sooner than the watchdog**. n8n's own "session invalid"
  message (`NOTIFY_SESSION`, on) comes at the first 401 `auth_invalid` reply, but no 401 happens
  while TikTok refuses a dead session as `publish_rejected`. Until then the earlier signals are
  warnings: `ReelsmithPaused` (two refusals in a row) and `ReelsmithNoPostToday` at
  13:00 SAST, which the failures pause does not silence. The fix is a sidecar change (probe after
  a `publish_rejected` verdict, and once at startup); it is not part of this change and waits for
  the owner's go-ahead. `tests/reelsmith-outage-2026-10-30.test.yml` replays the 30 Oct timeline
  and pins this gap. The wait is at least about 24 hours: a probe that reaches no verdict, or a
  skipped 09:45 run, leaves the last verdict in place. A restart during an outage also clears the
  alert (the new pod reports -1 until the next probe, so a RESOLVED goes out while the cookie is
  still dead); the startup probe in the same sidecar fix is what closes that.
- **Time windows** are written in UTC (`hour()`), because Prometheus has no time zones: SAST is
  UTC+2, so 13:00-21:00 SAST is `hour() >= 11 and hour() < 19`. Only the two dispatcher rules have
  one; a lasting state (paused, set aside, low backlog) stays one alert instead of resolving every
  night and firing again every morning. `ReelsmithDispatcherSilent` opens at 13:00, an hour after
  the first slot (the request before that slot is the previous day's 18:00 one), and closes at
  21:00, before the silence after the 18:00 slot reaches 3.5 h (21:30). `ReelsmithNoPostToday`
  opens at 13:00 too: by then the 12:00 slot has posted, so a single refusal at 12:00 raises it
  until the 15:00 slot posts. `scripts/monitoring.selfcheck.js` fails if either window stops
  fitting `SLOTS`.
- **Selectors** pin `job="tiktok-sidecar"` and `namespace="n8n-live"`, so a same-named Service in
  another namespace can neither raise nor hide an alert (`absent()` included).
- **Tests.** `tests/reelsmith-alerts.test.yml` (promtool, run in CI by the `promtool` job) covers
  every rule, every `unless`, the window edges, the namespace pin and the throttle edge;
  `tests/reelsmith-three-slots.test.yml` runs 48 hours of healthy three-slot days with the
  operator's full label set (no alert fires or even pends) and a missed 12:00, 15:00 and 18:00
  slot (each fires `ReelsmithDispatcherSilent` at its expected minute);
  `tests/reelsmith-outage-2026-10-30.test.yml` replays the 30 Oct outage on the three slots with
  the full label set and a pod restart. `scripts/monitoring.selfcheck.js` checks the port wiring, that only
  Prometheus reaches 9100 (both selectors in one `from` element) and nothing new reaches 8000, the
  exact alert names, each rule's static namespace label and severity, the namespace pin in every
  selector, and the drill's name.

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
4. **Metrics and alerts (sidecar 0.5.0).** The image pin, the metrics port, the ServiceMonitor,
   the scrape NetworkPolicy and `reelsmith-alerts` go live together in one manual sync of
   `reelsmith-social-publish`; merging deploys nothing. Everything else merged since the last
   sync goes with it, so read the whole diff.
   - **When.** Outside a slot and the 20 minutes after it (12:00, 15:00, 18:00 SAST), and only
     once the sidecar log shows no upload in flight: the slot's upload has logged its
     `uploader error_id=... verdict=...` line, or there was none:
     `ssh homelab 'microk8s kubectl -n n8n-live logs deploy/tiktok-sidecar -c tiktok-sidecar --since=30m'`.
     The Deployment is Recreate: a restart during an upload leaves it ambiguous. In the plan's
     order this sync comes after the homelab-infra null route for Reelsmith warnings (A3b);
     before it, the warnings reach Telegram as well.
   - **The workflow.** This sync went out on 2026-10-31 with the five-slot schedule still in
     git; step 5 brings git back to three slots and is deployed as one window.
   - **Sync** as in step 1, then check the pod runs the 0.5.0 digest:
     `ssh homelab 'microk8s kubectl -n n8n-live get pods -l app.kubernetes.io/name=tiktok-sidecar -o jsonpath="{.items[*].spec.containers[0].image}"'`.
   - **Verify the scrape and the rules.** Each command below is read-only and runs in the
     Prometheus pod, behind this prefix:
     `ssh homelab 'microk8s kubectl -n observability exec prometheus-kube-prom-stack-kube-prome-prometheus-0 -c prometheus -- <command>'`.
     - target up: `wget -qO- 'http://localhost:9090/api/v1/query?query=up%7Bjob%3D%22tiktok-sidecar%22%7D'`
       shows `"value":[...,"1"]`;
     - rules loaded: `wget -qO- 'http://localhost:9090/api/v1/rules?type=alert&rule_group%5B%5D=reelsmith.rules'`
       lists the 11 `Reelsmith*` names, with `"health":"ok"`;
     - the metrics port serves nothing else: `wget -S -O /dev/null http://tiktok-sidecar.n8n-live.svc:9100/api/upload`
       answers `404 Not Found`;
     - the API is still closed to Prometheus: `wget -T 5 -O /dev/null http://tiktok-sidecar.n8n-live.svc:8000/healthz`
       times out (a NetworkPolicy drop is a timeout, not a refusal);
     - the values match `/api/stats` (posted today, paused, posting enabled) and the ledger.
   - **Critical-path drill (`ReelsmithDrill`)**, right after, still outside a slot:
     `ssh homelab 'microk8s kubectl create -f -' < manifests/test/reelsmith-drill.yaml`.
     It has its own alert name, because Alertmanager groups by namespace and alertname and the
     desk keys an incident the same way, so a drill named like a real alert would be one with
     it. It is critical, so it takes the same route as `ReelsmithSessionInvalid`. It fires at the
     next rule evaluation; the Telegram message "CRITICAL: ReelsmithDrill" (description "DRILL,
     nothing is wrong") should arrive within about 2 minutes. Note the delay, then delete it:
     `ssh homelab 'microk8s kubectl -n n8n-live delete prometheusrule reelsmith-drill'`
     (a resolved message follows). The desk allowlists `ReelsmithDrill` for its own drills; if
     it opens an incident, close it.
   - **Rollback:** revert this change in a PR and sync, outside a slot as above. The ledger stays
     readable: 0.5.0 adds no row field and no status, only the code value `publish_throttled`,
     and 0.4.0 reads `code` as free text (tiktok-sidecar PR #5 tests a rollback reader).

5. **Three posts a day, and the first workflow deploy since 2026-10-18 (ADR-0002, second
   2026-10-31 amendment).** Merging deploys nothing (`reelsmith-social-publish` and the workflow
   are both manual). The sync and the workflow deploy go in ONE window, sync first.
   - **Deadline: sync before 10:00 SAST on 2026-11-01**, or plan for one false warning. The
     live `ReelsmithDispatcherSilent` still has the 10:00-22:00 SAST window. At 22:13 SAST on
     2026-10-31 the sidecar reported 77 clips ready, the last upload request at 18:32:05 SAST
     and no pause, so with no request before the 12:00 slot it fires at about 10:05 SAST and
     stays up until 12:00 (a warning: it reaches Telegram until the desk's null route, plan item
     A3b, is in place). The sync alone fixes it, because the new window fits the three slots the
     deployed workflow already runs. If the sync cannot land in time, silence
     `ReelsmithDispatcherSilent` in Alertmanager from 10:00 to 12:30 SAST, or accept the warning.
   - **What the sync changes.** The sidecar's `DAILY_CAP` goes back to 3 and `ATTEMPT_CAP` to 6
     (the 2026-10-31 15:19 SAST sync applied 5 and 10; the Deployment restarts, Recreate), and
     `ReelsmithDispatcherSilent` gets its 13:00-21:00 SAST window. The watchdog CronJob change
     is comments only.
   - **What the workflow deploy changes.** The live workflow is git `178b7dd` (n8n versionId
     `daf5bb84`, published 2026-10-18 17:18 UTC, its only `workflow_history` row). This deploy
     brings everything merged since, in one go:
     - #72: an "uploaded as Only me" Telegram notice on every post (up to 3 a day);
     - #78: rotation across source videos (never the same video twice in a row), a video's
       `00_` intro is never posted, and Archive Manifest counts intros as done (the live
       workflow claimed the intro `00_Convenience and productivity.mp4` on 2026-10-30);
     - #79: a 502 `publish_rejected` or `signature_failed` is no longer "may have posted";
     - #80: a refused clip is retried once at a later slot, after another clip of its video
       (`REFUSAL_LIMIT` 2); `.state/retryable-failures.json` gains `refusals` and `retryAfter`;
     - #81: quiet Telegram (`NOTIFY_INFO` false), with the two owner gates on (below);
     - `MIN_GAP_MIN` 170 to 160: a late slot catches up 15 minutes per slot.

     Slots, cron and `LAST_CALL` are the ones n8n already runs (12:00/15:00/18:00, markers
     0/1/2, `*/15 12-20 * * *`, 21:00).
   - **Telegram, before and after the workflow deploy** (Log Results; the watchdog is unchanged):

     | Message | Live today (`178b7dd`) | After this deploy |
     |---|---|---|
     | "uploaded as Only me, set it to Everyone" | not sent | **new**: every post, up to 3 a day |
     | clip refused, 400 bad input or 413 too large | sent | sent |
     | upload outcome unknown (500, 504, any other 502, a timeout after sending) | sent | sent |
     | TikTok session invalid (401), the 1st in a row, then every 12th | sent | **still sent**, same text and cadence (owner decision, `NOTIFY_SESSION`) |
     | sidecar unavailable N times in a row, 503 `network_before_upload` or `clock_unsynced` | sent at 3, then every 12th | **still sent**, same text and threshold (owner decision, `NOTIFY_SIDECAR_DOWN`) |
     | TikTok refused it (502 `publish_rejected`) | sent, as "upload outcome unknown (it may have posted)" | **stops**: the 1st refusal is retried silently (nothing replaces the notice); the 2nd sets the clip aside silently, `ReelsmithClipsSetAside` after 15 min |
     | "You are posting too fast" (502), a signing failure (502 `signature_failed`) | sent, as "upload outcome unknown" | **stops**: deferred to a later slot; `ReelsmithThrottled` covers the throttle, nothing names a signing failure |
     | sidecar unavailable, 503 `busy` or `paused`, or the sidecar not answering | sent at 3, then every 12th | **stops**: `ReelsmithPaused`, `ReelsmithSidecarDown`; `busy` is another upload holding the lock |
     | a clip blocked by an earlier unknown upload (409 `ambiguous`) | sent | **stops**: `ReelsmithAmbiguousUpload` |
     | the kill switch off while live, once a day | sent | **stops**: `ReelsmithPostingDisabled` |
     | manifest problems, once a day | sent | **stops**: only the list in `.state/notices.json`, and the watchdog's failed-execution check when nothing else can be posted |
     | daily cap reached | not sent | not sent (only with `NOTIFY_INFO`) |
   - **Expect `ReelsmithNoPostToday` about one day in four.** It fires at 13:15 SAST whenever the
     12:00 attempt is refused: the ledger since 2026-10-18 holds 7 `publish_rejected` of 28
     attempts (15 posted, 6 `internal`). The sidecar's failure streak also spans midnight: a
     refused last attempt yesterday plus a refused 12:00 today pause posting for 12 hours, so the
     rest of that day has 1 attempt and 0 posts.
   - **Claims the old workflow wrote for TikTok refusals stay `failed`** and are never retried:
     see "When a clip is set aside" for the safe release, one clip at a time.
   - **When.** Outside a slot and the 20 minutes after it (12:00, 15:00, 18:00 SAST), once the
     sidecar log shows no upload in flight (step 4's command); before 10:00 SAST meets the
     deadline above.
   - **Commands.** Before the window, create an n8n API key in the n8n UI with the shortest
     expiry and copy it; delete it once step (d) is done. From the Mac, in
     `projects/reelsmith-social-publish/scripts`:
     ```bash
     # (a) sync reelsmith-social-publish (step 1), then check the caps: value "3" and value "6"
     ssh homelab 'microk8s kubectl -n n8n-live get deploy tiktok-sidecar -o yaml' | grep -A1 -E 'name: (DAILY|ATTEMPT)_CAP'
     # (b) the posting ledger's length, to compare after the dry run
     ssh homelab 'microk8s kubectl -n n8n-live exec deploy/tiktok-sidecar -c tiktok-sidecar -- wc -l /app/CookiesDir/ledger.jsonl'
     # (c) dry-run deploy: saved, never published (the published version keeps the schedule);
     #     the API key goes on stdin; the id is the one in the editor URL and the watchdog's messages
     WF=SKLkX5qUDYLlWTxo
     pbpaste | N8N_SSH_HOST=homelab-tunnel ./deploy-workflow.sh --workflow-id "$WF" --dry-run
     ```
     Then open the workflow in the n8n editor and execute it once by hand (it runs the saved
     dry-run copy). In that execution, check that Pick Due Clip shows `dryRun: true` and a
     `clip_key` from a YouTube job whose filename does not start with `00_`, from a different
     video than the last post; that TikTok Sidecar Upload answered 200 with `status: dry_run`;
     and that Log Results shows `outcome: dry_run` and `clipReleased: true`. Then confirm nothing
     posted (the ledger has the same length as in (b), and the dry-run log has the new row):
     ```bash
     ssh homelab 'microk8s kubectl -n n8n-live exec deploy/tiktok-sidecar -c tiktok-sidecar -- sh -c "wc -l /app/CookiesDir/ledger.jsonl; tail -n 1 /app/CookiesDir/ledger.dryrun.jsonl"'
     # (d) live deploy: saved with DRY_RUN=false and published
     pbpaste | N8N_SSH_HOST=homelab-tunnel ./deploy-workflow.sh --workflow-id "$WF" --live
     ```
   - **After the live deploy** (read-only checks):
     - the published version is new: the first field below is no longer `daf5bb84-...`
       `ssh homelab 'microk8s kubectl -n n8n-live exec n8n-application-postgres-0 -c postgres -- psql -U postgres -d n8n -At -c "SELECT \"activeVersionId\", settings FROM workflow_entity WHERE name = \$\$Reelsmith Social Publish\$\$"'`
     - **the workflow settings survived.** Live has `maxConcurrency: 1`, `binaryMode`,
       `callerPolicy` and `availableInMCP`; the generated JSON has none of them, and the public
       API refuses `maxConcurrency`. The deployed n8n 2.39.8 merges settings on an update
       (`{...old, ...new}` in `dist/workflows/workflow.service.js`, read in the pod on
       2026-10-31), and the 2026-10-18 deploy sent the same keys while all four survived, so they
       should stay. Compare the copy of the old workflow that the dry-run deploy saved (after the
       two deploys it is the second newest file in `../backups/`, mode 0600; the public API
       returns its settings whole) with the live settings:
       ```bash
       ssh homelab 'microk8s kubectl -n n8n-live exec n8n-application-postgres-0 -c postgres -- psql -U postgres -d n8n -At -c "SELECT settings FROM workflow_entity WHERE name = \$\$Reelsmith Social Publish\$\$"' > /tmp/reelsmith-settings-after.json
       node -e 'const fs = require("fs"); const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).settings || {}; const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); const lost = Object.keys(before).filter((k) => !(k in after)); console.log("before:", Object.keys(before).sort().join(" ")); console.log("after: ", Object.keys(after).sort().join(" ")); console.log(lost.length ? "LOST: " + lost.join(" ") : "no setting lost");' "$(ls -tr ../backups/*.json | tail -n 2 | head -n 1)" /tmp/reelsmith-settings-after.json
       ```
       If `maxConcurrency` is lost, the risk is low: claims are exclusive files (created with
       O_EXCL, so two overlapping runs never take the same clip or slot) and the workflow's
       `executionTimeout` is 900 s, under the 15-minute tick. The 2.39.8 editor cannot put it
       back: its workflow settings do not offer `maxConcurrency` (the editor bundle names the
       key only in its Evaluations view, checked 2026-10-31). Leave it off, note it in the
       session log, and decide on any other way separately.
     - at the next slot: one execution, the "uploaded as Only me" notice after a post, and the
       upload in `ssh homelab 'microk8s kubectl -n n8n-live logs deploy/tiktok-sidecar -c tiktok-sidecar --since=30m'`.
     - delete the n8n API key in the n8n UI.
   - **Rollback:** revert this change in a PR and sync, outside a slot. For the workflow,
     follow go-live step 10 (`--deactivate` first; the deploy saved the old copy in `backups/`).

## Mac setup

1. Set `YTVIDEO_EXPORT_BASE_FOLDER` in Reelsmith `.env` to your local Syncthing share folder
   (for example `~/Sync/reelsmith-inbox`).
2. In the Syncthing web UI on the Mac:
   - add the homelab Syncthing as a remote device via `<node-ip>:32200`;
   - share the folder targeting `/var/syncthing/reelsmith-inbox` on the cluster side;
   - set the Mac folder to **Send Only** and the cluster side to **Receive Only**;
   - add a `.stignore` with `*.tmp`, `.DS_Store` and `processed/`.
3. New clips reach the cluster only while the Mac is awake with Tailscale up, and nothing posts
   while the homelab is off. Keep it on from 11:30 to 21:00 SAST for the slots, and from 09:30
   to 22:00 for the watchdog's 09:45 probe and its 21:45 run.

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
   executed by hand from the editor (`simulate` is honoured only in dry runs). Confirm Log Results
   reports `auth_invalid` with the clip released, and that the Telegram message "[dry run] 🔑
   Reelsmith: TikTok session invalid (1 in a row) ..." arrives (`NOTIFY_SESSION` is on).
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

    The saved copy's path is recorded in the session log. While the workflow stays off, the
    watchdog stays quiet about executions (there are none to fail) and keeps checking the sidecar
    and the cookie once a day; set it back to `suspend: true` in the same PR only if the sidecar
    is also taken down.

## When a clip is set aside

A clip with an unclear or refused outcome keeps its n8n claim, so it is never retried and its
manifest is never archived. When the outcome is one of the messages sent with the shipped gates
(400/413, an unknown outcome), the Telegram alert prints the exact commands for that clip;
otherwise `ReelsmithClipsSetAside` fires after 15 minutes and the commands are the ones below.
Every command here runs from the Mac against the homelab and is the owner's to run. **Never
click "Revert Local Changes"** on the cluster's Syncthing folder: it deletes every claim.

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
- **TikTok refused to publish it** (502 `publish_rejected`; not posted, the sidecar's ledger key
  is already free). Refusals are often intermittent: the same clip and caption can post on a later
  try. The 1st refusal releases the clip back to the pool (a "refusal 1 of 2" notice only with
  `NOTIFY_INFO`; nothing replaces it, the clip simply comes back). The next attempt takes another
  clip of the same video first (unless it is that video's only ready clip), and a later attempt
  retries the refused one. The 2nd refusal of the same clip sets it aside (an alert only with
  `NOTIFY_INFO`; `ReelsmithClipsSetAside` fires after 15 minutes): probably the clip itself;
  re-export it, then release the claim with the same command. Or leave it set aside. Either way the slot stays used: at most one upload
  attempt per slot. The sidecar also pauses posting for 12h after 2 failed attempts in a row, so
  back-to-back refusals can cost the rest of the day's slots. Putting another clip between a
  refusal and its retry makes two failures in a row less likely; a retry never directly follows
  its own refusal. The per-clip count lives in `.state/retryable-failures.json` (`refusals`, the
  newest 50 clips) and is dropped once the clip's outcome is final. The flag `retryAfter` (the
  clip waiting behind another) is dropped once an attempt posts, or when the flagged clip itself
  reaches a final outcome; it lasts through released attempts (e.g. a sidecar 503), not only the
  next pick. A refusal that says "You are posting too fast", and a 502
  `signature_failed`, are not the clip's fault: the clip is released for a later slot (a
  Telegram alert only with `NOTIFY_INFO`; `ReelsmithThrottled` covers the throttle).
- **A TikTok refusal recorded by the workflow deployed before 2026-11** (git `178b7dd`). That
  workflow logged every 502 as "may have posted", so its claim says `"status": "failed"` with
  `"code": "publish_rejected"` and `"http_status": 502`. The retry once (ADR-0002, second
  2026-10-27 amendment) applies only to refusals the new workflow records itself: **these claims
  stay `failed` and are never retried**, and their manifests do not archive. Example:
  `851cbce7386b47959c6136cc3fa9758e/02_Smart home and mobile gear.mp4`, refused 2026-10-31,
  ledger key free. To give one a retry:
  1. read the claim, and go on only if it shows `failed`, `publish_rejected` and 502:
     `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- cat "/data/reelsmith-inbox/reelsmith-inbox/<job>/.claims/<filename>.json"'`;
  2. check TikTok Studio that the clip is not on the account, then in `tiktok-sidecar` run
     `make ledger-resolve KEY='<job>/<filename>' OUTCOME=not_posted`. For a 502 refusal it is
     refused with "no ledger rows for that clip_key" or "...; it is free" (the refusal already
     freed the key). If the clip is on TikTok after all, run `OUTCOME=posted` instead;
  3. release the claim (the same command as above):
     `ssh homelab 'microk8s kubectl -n n8n-live exec deploy/n8n-application-worker -- rm "/data/reelsmith-inbox/reelsmith-inbox/<job>/.claims/<filename>.json"'`.
  The clip goes back to the pool and is uploaded at its turn; a new refusal counts as refusal 1
  of 2. If it had posted after all, the sidecar answers 409 `duplicate` and nothing posts twice.
  A `00_` intro claim (for example `00_Convenience and productivity.mp4`, refused 2026-10-30) is
  not worth releasing: the new workflow never posts intros, and Archive Manifest counts them as
  done.

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
- The sidecar and cookie checks run only at 09:45. If the homelab is off then, that day's checks are
  skipped; failed executions are still reported on the later runs. Once the Reelsmith alert rules are
  live (plan section A2), `ReelsmithSidecarDown` covers the sidecar. It does not cover the session:
  with no 09:45 probe, `ReelsmithSessionInvalid` sees a dead cookie only if the cookie file is
  unusable (see [Alerts](#alerts)).
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
