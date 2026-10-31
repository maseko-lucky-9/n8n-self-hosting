# ADR-0002: The TikTok sidecar is the posting gatekeeper; a 15-minute n8n dispatcher feeds it

- **Status:** Accepted 2026-10-17. Pointer record: the full decision, evidence and rejected
  options live in Reelsmith's
  [ADR-012](https://github.com/maseko-lucky-9/reelsmith/blob/main/docs/decisions/012-tiktok-posting-gatekeeper.md)
  (`docs/decisions/012-tiktok-posting-gatekeeper.md` in the `reelsmith` repo).
- **Deciders:** owner.
- **Supersedes:** the Wait-based schedule and the YouTube branch of
  `projects/reelsmith-social-publish`.

## Context

The Reelsmith Social Publish workflow has been inactive since 2026-06-20, and the stored copy
could not post. It sent the Mac's absolute clip path, and its Wait node released a whole job at
once. Clips reach 248 MB, more than the n8n worker's 512Mi limit can carry. The host is often off
in the evening and boots with a wrong clock. This repository holds the n8n side of the fix (the
workflow, its scripts and the Kubernetes manifests), so it records where that design comes from.

## Decision

1. **The sidecar is the gatekeeper.** `tiktok-sidecar` reads the clip from a read-only mount of
   the inbox and validates the path and the file. It keeps the posting ledger, enforces the daily
   cap and refuses duplicates by name and by content hash. It also holds the kill switch
   (`POSTING_ENABLED`, off by default).
2. **A 15-minute dispatcher replaces the Wait.** The workflow runs every 15 minutes from 12:00 to
   20:45 SAST and posts at most one clip per run, in three daily slots (12:00, 15:00, 18:00),
   newest job first. *Amended 2026-10-26: the order is now a rotation across source videos
   (never the same video twice in a row; a video holding more than half of the ready clips goes every other post; otherwise least recently used first), and each video's intro
   (`00_*` or titled "Intro") is never posted. See the README's Candidates bullet.*
   *Amended 2026-10-27: five daily slots (09:00, 12:00, 15:00, 18:00, 21:00), runs from 09:00
   to 21:45 SAST. See "Amendment 2026-10-27" below.* *Withdrawn 2026-10-31: back to the three
   slots above, at most 3 uploads a day (owner policy). See "Amendment 2026-10-31 (second)"
   below.*
3. **No binaries in n8n.** n8n sends a relative `clip_path`; the video never passes through an
   n8n pod.
4. **Fail closed.** The ledger is written before an upload; an unfinished attempt blocks that
   clip until a person resolves it. Only outcomes that certainly did not start release a clip.
5. **Manual sync.** The live ArgoCD Application (`homelab-infra/argocd/applications/reelsmith-social-publish.yaml`)
   syncs manually, so merging here deploys nothing until the owner syncs. The workflow is
   deployed through the n8n API by `scripts/deploy-workflow.sh`, never automatically. The stale
   auto-sync copy of the Application in this repository is deleted.

## Consequences

- Real uploads stay off until go-live step 7 flips `POSTING_ENABLED` in a reviewed manifest
  change. The go-live runbook and rollback are in `projects/reelsmith-social-publish/README.md`.
- The watchdog CronJob ships suspended and is switched on after the first real post (since 2026-10-28 its checks are trimmed, see the 2026-10-28 amendment).
- n8n needs no memory increase for big clips; the sidecar's limit rises to 1.5Gi instead.

## Amendment 2026-10-27: five slots, and a TikTok refusal is not "may have posted"

*Partly withdrawn on 2026-10-31 (see "Amendment 2026-10-31 (second)"): the five-slot schedule,
the 09:00-21:45 runs, the 22:00 last call and the caps of 5 and 10 are withdrawn, back to three
slots and caps of 3 and 6. The rejection mapping and `MIN_GAP_MIN` 160 below stay.*

**Owner decision (withdrawn 2026-10-31).** Two slots are added, 09:00 and 21:00 SAST, for five
a day: 09:00, 12:00, 15:00, 18:00 and 21:00. The dispatcher runs every 15 minutes from 09:00 to
21:45 (`*/15 9-21 * * *`, 52 runs a day) and stops catching up at 22:00. The sidecar's deployed caps rise with it:
`DAILY_CAP` 3 to 5 and `ATTEMPT_CAP` 6 to 10 (two attempts per slot). The watchdog runs 45
minutes after each slot; its daily digest moves to the 09:45 run, which looks back 13 hours.

- **Why these times.** The seed audience is South African. 21:00 SAST is the evening peak in
  South Africa and the UK and early afternoon on the US east coast; 09:00 reaches the South
  African morning only. 12:00 and 15:00 sit in the weakest engagement band and stay as they are
  for now. Once about 10 posts are public, the audience split in TikTok Studio decides whether
  to retime.
- **Risk.** Five uploads a day is above the three a day this record first treated as ordinary
  behaviour. If the root-cause tests below point at throttling, the cap is not raised further,
  and the owner decides whether to go back to three.
- **`MIN_GAP_MIN` 170 to 160** (kept on 2026-10-31; the five-slot example below is history).
  Runs fall on the quarter hour, so a 170-minute gap acted as 180
  and a late slot never caught up. At 160 a late slot gains 15 minutes per slot: a 09:00 slot
  first claimed at 10:00 still posts the 21:00 slot at 21:00, with at most five posts a day and
  at least 165 minutes between them. On the deploy day the old workflow's slot markers are read
  with the new slot numbers; simulated deploys at 08:00, 13:00, 19:00 and 21:10 still give at
  most five posts at least 160 minutes apart (a mid-day deploy can lose that day's 21:00 slot).

**Rejection mapping.** The sidecar records `publish_rejected` and `signature_failed` as failed:
provably not published, ledger key free, HTTP 502 with `code` in the body. Log Results used to map
every 502 to "may have posted", so the clip stayed blocked for good. Now:

| Sidecar reply | Outcome | Effect |
|---|---|---|
| 502 `publish_rejected` | `needs_you` | *Superseded by the second 2026-10-27 amendment below: retried once first.* Claim set aside; the slot stays used; it neither counts toward the "3+ refused in a row" streak nor ends it. Alert: "TikTok refused to publish it (not posted)", with the release command |
| 502 `publish_rejected` with `tiktok_status_msg` exactly "You are posting too fast. Take a rest." | `deferred` | Clip released for a later slot; the slot stays used; safety alert (possible throttling) |
| 502 `signature_failed` | `deferred` | As above; the alert names the signing helper |
| Any other 502, and 500 and 504 | `ambiguous` | Unchanged: may have posted |

### Phase 1 test results

Live Only-me test uploads, each at least 165 minutes after the previous upload, to tell a
caption cause from throttling. Raw ledger rows stay in the session log.

| Test | Clip and caption | Result |
|---|---|---|
| T1 | `04_STRONG`, unchanged | 2026-10-27 09:58 SAST: 04_STRONG, caption unchanged from 2026-10-21 (287 chars, en dash, 5 tags / 58 tag chars) -> HTTP 502 publish_rejected, tiktok_status_code 5, tiktok_status_msg null. Rejected again with the same caption (n=2); consistent with a caption cause. Not throttling text. |
| V1 | `15_Varia RearVue 820`, unchanged | 2026-10-27 16:58 SAST: 15_Varia RearVue 820 (refused at 15:00 with this caption) re-sent unchanged via the sidecar -> posted. Intermittent refusal, not a clip or caption fault. |
| T2 | `04_STRONG`, body with the en dash replaced by `-`, no hashtags | dropped: the caption hypotheses (dash, length, tag text) were refuted by the Varia refusal (no dash, 299 chars, 44 tag chars) and the Redshift post (379 chars) |
| T3 | `10_MUSGUARD OMNI`, em dash replaced by `-`, tags unchanged | dropped: the caption hypotheses (dash, length, tag text) were refuted by the Varia refusal (no dash, 299 chars, 44 tag chars) and the Redshift post (379 chars) |
| T4 | `12_Extrawheel`, full body and one tag (needs the owner's approval) | dropped: the caption hypotheses (dash, length, tag text) were refuted by the Varia refusal (no dash, 299 chars, 44 tag chars) and the Redshift post (379 chars) |
| R1 | `04_STRONG`, the bare title and no hashtags | pending: 04_STRONG re-sent with the bare title and no hashtags (refused twice with its full caption) |

## Amendment 2026-10-27 (second): a refused clip is retried once, after another clip

This supersedes the "set aside on the first refusal" row of the rejection mapping above.

**Evidence.** The sidecar refused `15_Varia RearVue 820` at 2026-10-27 15:00 SAST (502
`publish_rejected`, status code 5). The same clip, with the same caption and tags, posted when it
was re-sent at 16:58 SAST (V1 above). Since 2026-10-25, 11 upload attempts reached TikTok: 7
posted and 4 refused (about 36%); n8n alone: 6 posted and 3 refused. No two refusals were ever in
a row. Refusals are therefore at least partly intermittent, and setting a clip aside at its first
refusal would lose clips that post on a second try.

**Rule.** Log Results counts TikTok refusals per clip (`refusals` in
`.state/retryable-failures.json`, keyed by `<job>/<file>`). Only a non-throttle 502
`publish_rejected` counts; the throttle message and `signature_failed` stay `deferred` and do not.

| Refusal of the clip | Effect |
|---|---|
| 1st | Clip released back to the pool and recorded as `retryAfter`: the next attempt takes another clip of the same video first (unless it is that video's only ready clip), and a later slot retries the refused one. Row status `refused_retry`; a Telegram notice "refusal 1 of 2" (informational) |
| 2nd | Claim `needs_you`, set aside as before; safety alert "TikTok refused to publish it twice", with the release command |

- **Why 2.** One retry recovers an intermittent refusal; a second refusal of the same clip points
  at the clip, and further retries would spend attempts the other clips need. The sidecar also
  pauses posting for 12 hours after 2 failed attempts in a row.
- **Why the slot stays used, and why another clip goes first.** The sidecar's 12-hour pause
  depends only on 2 failed attempts in a row, not on their spacing. Keeping the slot means the
  retry comes at least 160 minutes later (one attempt per slot), and the retry-after rule puts a
  different clip in between. That makes two failures in a row less likely; a retry never directly
  follows its own refusal. A set-aside at the 2nd refusal may still coincide with the 12-hour
  pause if the attempt before it also failed.
- **retryAfter** names the clip just released after a refusal. While it is set, Pick Due Clip
  moves that clip one place back within its video. It is dropped once an attempt posts, or when
  the flagged clip itself reaches a final outcome; it lasts through released attempts (e.g. a
  sidecar 503) and other clips' set-asides, not only the next pick. Dry runs never set it.
- **Known limits.** If the refused clip is its video's only ready clip, it is retried at the next
  attempt even when another video could go (documented and tested). Independent refusals still
  produce consecutive-failure pairs at about the same rate; only a refusal tied to the clip
  itself gets better.
- **Lifetime of the count.** It is dropped once the clip's outcome is final (posted,
  posted_elsewhere, set aside, ambiguous) and kept while the clip is only released (sidecar busy,
  cookie, daily cap, deferred). Dry runs never read or change it. Only the newest 50 clips are kept.
- The `needs_you` streak is unchanged: a refusal neither counts toward it nor ends it.

## Amendment 2026-10-28: the homelab desk owns the alerts; Telegram keeps only what it cannot

**Why.** The owner was checking every upload by hand and received about 8 to 10 Telegram messages
a day from Log Results and the watchdog. The homelab desk (OpenClaw, on the Mac) now diagnoses
every upload, failure, pause and set-aside clip from the sidecar's metrics and hands real faults
to the desk's existing agents, so the raw per-event messages are duplicates. Plan:
the owner's plan "Reelsmith upload monitoring on the OpenClaw homelab desk", section A2b (Telegram budget: about 3 "Only me" notices
a day, plus at most 1 other desk message a week).

- **Log Results** keeps three messages: "uploaded as Only me, set it to Everyone" (the owner's
  decision on 2026-10-26: it is the one action they must take), a 400/413 clip fault (the desk
  cannot see why a clip is bad), and an unknown upload outcome (a timeout or unexpected answer:
  the clip may be on TikTok as Only me, and only the owner can check). First refusal, set-aside
  after two refusals, throttling, signing failure, a clip blocked by an earlier unknown upload,
  sidecar unavailable, session invalid, daily cap, kill switch and manifest problems sit behind
  the constant `NOTIFY_INFO`, shipped as `false`. The gate is on the outgoing message only:
  claims, slots, counters and rows are unchanged, so no outcome logic moved. A gated notice
  never fails the run. *Changed by the second 2026-10-31 amendment: "session invalid" and "sidecar
  unavailable" for 503 `network_before_upload` / `clock_unsynced` stay on, each behind a gate of
  its own (`NOTIFY_SESSION`, `NOTIFY_SIDECAR_DOWN`), and fail the run when they cannot be sent.*
- **The watchdog** keeps its per-run failed-execution check: nothing else reads n8n's execution
  state, and the Reelsmith alert rules do not either. The 09:45 run still reports the sidecar
  down or the cookie invalid, as before (the Mac-asleep backstop). Dropped, because the desk owns
  them: the `/api/stats` checks (no success for 48h, paused, stats unreadable) and "no
  executions in 25h". Once the A2 alert rules are live, Alertmanager's critical alerts are a
  second backstop for the sidecar; for the session the alert is only as fast as the 09:45 probe
  (see the 2026-10-31 amendment).
- **Rollback.** Set `NOTIFY_INFO` to `true` and rebuild the workflow to get every message back;
  `git revert` restores the old watchdog.
- **Ordering.** Merge and deploy only after the A2 alert rules are loaded and sidecar 0.5.0 is
  being scraped; until then the desk has nothing to watch with and the gated messages are the
  only signal.
- **Deploy.** The workflow JSON needs the owner's n8n API key and the CronJob a manual sync of
  `reelsmith-social-publish`, outside a slot and the 20 minutes after it.

## Amendment 2026-10-31: Prometheus scrapes the sidecar, and 11 alert rules watch it

**Why.** On 2026-10-31 the TikTok session cookie was found dead: uploads had been refused for
about 24 hours and no alert fired. Only the watchdog's 09:45 run looked at the session, and
nothing read the sidecar's ledger state. The homelab desk (previous amendment) also needs a
signal to diagnose from. Plan: the owner's plan "Reelsmith upload monitoring on the OpenClaw
homelab desk", section A2.

- **Scrape.** Sidecar 0.5.0 (tiktok-sidecar PR #5) serves Prometheus metrics on its own port,
  9100, and nothing else there. The Deployment pins the 0.5.0 digest and names the port, the
  Service exposes it, and `tiktok-sidecar-servicemonitor.yaml` has kube-prom-stack scrape it
  every 30 s as job `tiktok-sidecar`. A scrape reads the ledger, the inbox and the cookie file
  and never calls TikTok.
- **Network.** A separate NetworkPolicy, `prometheus-to-tiktok-sidecar-metrics`, admits only the
  Prometheus pod of the `observability` namespace (both selectors in one `from` element, so they
  are AND'd) and only to 9100. The upload API on 8000 stays reachable from n8n, its worker and
  the watchdog only. `scripts/monitoring.selfcheck.js` fails CI if either drifts.
- **Alerts.** The PrometheusRule `reelsmith-alerts` holds 11 alerts (README, "Alerts"). Three are
  critical and page Telegram through Alertmanager whether or not the desk is awake: sidecar down,
  session invalid, ledger unreadable. Eight are warnings for the desk, which allowlists the names
  exactly. Every rule sets `namespace: n8n-live` statically (Alertmanager groups by alertname and
  namespace), and every selector pins `job="tiktok-sidecar"` and `namespace="n8n-live"`, so a
  same-named Service elsewhere can neither raise nor hide an alert.
- **The session, and its limit.** `ReelsmithSessionInvalid` fires on a probe verdict of 0, a
  cookie file without a session, or any `auth_invalid` reply in the last hour, after 5 minutes.
  A verdict of -1 (unknown, after every restart) never pages by itself. **The rule is only as
  fast as the probe cadence.** A cookie that dies while its file is still on disk is invisible
  until a probe runs: the verdict stays at its last value, the cookie file still loads, and the
  sidecar answers `auth_invalid` only after a probe has said invalid. TikTok's refusal for a dead
  session (status code 7 on 2026-10-30) is classed `publish_rejected` and triggers no probe.
  After the sync the only routine probe is the watchdog's 09:45 SAST run, so the worst case is
  at least about 24 hours (a probe that reaches no verdict, or a skipped 09:45 run, leaves the
  last verdict in place and adds another day), the same as the watchdog: the 30 Oct class is NOT caught within minutes by
  this change. The earlier signals are warnings: `ReelsmithPaused` after two refusals, and
  `ReelsmithNoPostToday` at 13:00 SAST, which the failures pause does not silence. The fix is a
  sidecar change (probe after a `publish_rejected` verdict, and once at startup), not part of
  this change and awaiting the owner's go-ahead. `tests/reelsmith-outage-2026-10-30.test.yml`
  replays the timeline and pins the gap. A restart during an outage also clears the alert: the new
  pod reports session_valid -1 until the next probe, so Alertmanager sends a RESOLVED while the
  cookie is still dead; only the startup probe in the sidecar fix closes that.
- **Time windows** are UTC in PromQL (SAST is UTC+2 all year). Only the two dispatcher rules have
  one (13:00-21:00 SAST for `ReelsmithDispatcherSilent` since the second 2026-10-31 amendment, it
  was 10:00-22:00; 13:00-22:00 SAST for `ReelsmithNoPostToday`); lasting states stay one alert
  rather than resolving each night.
- **Tests.** `promtool test rules` runs in CI (job `promtool`) on prom/prometheus v3.10.0, the
  live version, pinned by digest. The live Prometheus selects every ServiceMonitor and
  PrometheusRule in every namespace (selectors `{}`, checked 2026-10-31); the objects still carry
  `release: kube-prom-stack` in case the selector is narrowed to the chart default.
- **What stays with the watchdog.** Failed n8n executions: the rules see only what the sidecar
  exports. Its 09:45 sidecar and cookie checks remain the backstop. The critical alerts are a
  second one for a sidecar that is down or a ledger that is unreadable; for the session they are
  no faster than the watchdog's probe (above).
- **Deploy.** Merging deploys nothing. The owner syncs `reelsmith-social-publish` outside a slot
  and the 20 minutes after it, once the sidecar log shows no upload in flight, then checks that
  the target is up on 9100, that the 11 rules are loaded, that `:9100/api/upload` answers 404 and
  that 8000 stays closed to Prometheus, and runs the critical-path drill: the alert
  `ReelsmithDrill` from `manifests/test/reelsmith-drill.yaml`, a name of its own so it cannot
  merge with a real alert. Commands: README, "Deploy" step 4. *This sync went out on 2026-10-31
  with the five-slot schedule in git while n8n still ran three slots, so its 10:00-22:00
  `ReelsmithDispatcherSilent` window false-fires daily until the second 2026-10-31 amendment is
  synced.*

## Amendment 2026-10-31 (second): back to three posts a day (owner policy), caps 3/6, five-slot schedule withdrawn

**Owner policy.** At most 3 uploads a day. This is the owner's understanding of TikTok's limit,
not a number from TikTok's documentation. The five-slot schedule of 2026-10-27 is withdrawn:

- **Slots** 12:00, 15:00 and 18:00 SAST, as before 2026-10-27. The dispatcher runs every 15
  minutes from 12:00 to 20:45 (`*/15 12-20 * * *`, 36 runs a day) and stops catching up at 21:00
  (`LAST_CALL`).
- **Caps.** The sidecar's `DAILY_CAP` goes back to 3 and `ATTEMPT_CAP` to 6 (two attempts per
  slot). The 2026-10-31 sync had applied 5 and 10 while n8n still ran the three-slot workflow,
  so the dispatcher still asked for at most 3 a day; only the caps were looser than the policy.
  `workflow-contract.selfcheck.js` now fails on a slot count or `DAILY_CAP` over 3, not only on
  caps that disagree with the slots.
- **Kept.** From 2026-10-27: the rejection mapping (a TikTok refusal is not "may have
  posted") and `MIN_GAP_MIN` 160. With three slots a 12:00 slot first claimed at 15:15 still
  posts at 18:00 and 20:45 (at 170 the third would be lost), and posts stay at least 160 minutes
  apart. The once-a-day daily-cap notice is still in the code but is queued as information, so
  it is never sent while `NOTIFY_INFO` is false (the selfchecks open the gate to test it). The
  retry once after another clip (second 2026-10-27 amendment) and the quieter notices
  (2026-10-28) are untouched, apart from the two messages below.
- **Owner decision, two Telegram messages stay on.** `NOTIFY_INFO` stays false, and two gates of
  their own in `scripts/log-results.jsCode.js` ship on. `NOTIFY_SESSION`: "TikTok session
  invalid (N in a row). Run `make refresh-cookies` ..." on a 401 `auth_invalid`, the 1st in a
  row and then every 12th. The alert rules see a dead cookie only at the next session probe, so
  n8n's own message is the fast path. `NOTIFY_SIDECAR_DOWN`: "sidecar unavailable N times in a
  row; clips are waiting." on a 503 `network_before_upload` (the sidecar cannot reach TikTok) or
  `clock_unsynced`, the 3rd in a row and then every 12th. No alert rule sees either: requests
  still arrive and nothing is paused, so before this decision that pair was an accepted gap.
  Both keep the wording and cadence of the workflow deployed on 2026-10-18 (git `178b7dd`), and
  the selfchecks pin both. Every other unavailable answer (503 `busy` or `paused`, a sidecar that
  does not answer) stays behind `NOTIFY_INFO`: `ReelsmithPaused` and `ReelsmithSidecarDown`
  cover those.
- **Slot-marker indices.** Markers are named by position (`.slots/<day>-<i>.json`). The workflow
  deployed on 2026-10-31 (read from n8n: `SLOTS = ['12:00', '15:00', '18:00']`, cron
  `*/15 12-20 * * *`, `MIN_GAP_MIN` 170) writes 0, 1 and 2 for 12:00, 15:00 and 18:00, and this
  one keeps exactly that order, so a deploy at any time of day reads today's markers with the
  meaning they were written with. Simulated deploys at 11:00, 12:20, 16:00, 18:20 and 19:00 give
  at most 3 posts, at least 160 minutes apart; a selfcheck fails if the order changes.
- **The watchdog is unchanged.** Its runs are not upload slots. 09:45 probes the session before
  the first slot, so a dead cookie is reported before the 12:00 slot spends an attempt on it (the
  sidecar then answers `auth_invalid`, which claims nothing); 12:45, 15:45 and 18:45 follow the
  slots; 21:45 follows the last tick (20:45). The 09:45 run's 13-hour lookback reaches back to
  20:45 and overlaps the 21:45 run, so nothing is missed. Only its header comments described five
  slots, and they are corrected.
- **`ReelsmithDispatcherSilent`** keeps its 3.5-hour threshold and 5-minute `for`; its window
  moves from 10:00-22:00 to 13:00-21:00 SAST (`hour() >= 11 and hour() < 19`). The dispatcher
  calls the sidecar only at a slot, so on three slots the old window fired every day: at 10:05
  SAST (the request before the 12:00 slot is the previous day's 18:00 one, about 18 hours old)
  and from about 21:35 (3.5 hours after the 18:00 slot). Inside the new window a healthy day's
  longest silence is 3 hours (12:00 to 15:00, 15:00 to 18:00, 18:00 to the 21:00 close). A missed
  15:00 or 18:00 slot fires at about 15:36 or 18:36 SAST, a missed 12:00 slot at 13:05.
  `tests/reelsmith-three-slots.test.yml` proves both with the operator's full label set: 48
  healthy hours in which no Reelsmith alert fires or even pends, and each missed slot at its
  minute. `monitoring.selfcheck.js` fails if the window stops fitting `SLOTS`.
- **`ReelsmithNoPostToday`** stays at 13:00-22:00 SAST: by 13:00 the 12:00 slot has had an hour
  and an upload takes minutes. One consequence of three slots: a single refusal at 12:00 now
  raises it at 13:15 until the 15:00 slot posts (with five, a 12:00 post covered a 09:00
  refusal). With nothing posted that is the stall it watches for, so it is not changed.
- **`ReelsmithBacklogLow`** keeps its threshold of 10, now about 3 days at 3 a day.
- **The dead cookie.** `ReelsmithSessionInvalid` is still only as fast as the watchdog's 09:45
  probe (previous amendment); the 30 Oct replay now runs on the three slots and pins that. What
  the owner sees first is n8n's own 401 message (`NOTIFY_SESSION`), as with the workflow
  deployed today. That message does not help while TikTok refuses a dead session as
  `publish_rejected` (no 401 happens until a probe says invalid); `ReelsmithNoPostToday` at
  13:15 SAST is then the earliest signal, and the next 09:45 probe the first page.
- **What the workflow deploy brings.** The deployed workflow is git `178b7dd` (n8n versionId
  `daf5bb84`, published 2026-10-18, the only version n8n holds). This is the first deploy since,
  so it brings #72 (an "uploaded as Only me" notice on every post), #78 (rotation across source
  videos; `00_` intros never posted and counted as done by Archive Manifest), #79, #80 (retry
  once; the state file gains `refusals` and `retryAfter`), #81 (quiet Telegram, with the two
  messages above kept) and `MIN_GAP_MIN` 160, all at once. Claims that workflow wrote for TikTok
  refusals say `failed` and are not retried by #80. Such a claim is the only thing that stops a
  re-upload: after a refusal the ledger key is free, so the sidecar answers no 409 `duplicate`
  and `make ledger-resolve` refuses both outcomes ("it is free"). A clip found on TikTok keeps its
  claim; only a clip that is not on TikTok is released (README, "When a clip is set aside"). Expect
  `ReelsmithNoPostToday` on about one day in four: it fires at 13:15 SAST whenever the 12:00
  attempt is refused (7 of 28 attempts since 2026-10-18 were `publish_rejected`), and a refused
  last attempt the day before plus a refused 12:00 pause the rest of the day.
- **Deploy.** Merging deploys nothing. The sync of `reelsmith-social-publish` (caps 3/6, the
  alert window; the CronJob change is comments only) and the workflow deploy go in one window,
  outside a slot and the 20 minutes after it, sync first: before 10:00 SAST on 2026-11-01, or
  the old `ReelsmithDispatcherSilent` window false-fires at about 10:05 that morning. The workflow
  goes out as a dry run first, executed once by hand and checked, then live; the settings
  `maxConcurrency`, `binaryMode`, `callerPolicy` and `availableInMCP` are checked afterwards
  (n8n 2.39.8 merges settings on an update, so they should survive). Commands: README, "Deploy"
  step 5.

## Related

- `projects/reelsmith-social-publish/README.md`: flow, secrets, watchdog, go-live runbook.
- Reelsmith ADR-012 (linked above): the full record.
