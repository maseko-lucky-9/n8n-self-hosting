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
   to 21:45 SAST. See "Amendment 2026-10-27" below.*
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
- The watchdog CronJob ships suspended and is switched on after the first real post.
- n8n needs no memory increase for big clips; the sidecar's limit rises to 1.5Gi instead.

## Amendment 2026-10-27: five slots, and a TikTok refusal is not "may have posted"

**Owner decision.** Two slots are added, 09:00 and 21:00 SAST, for five a day: 09:00, 12:00,
15:00, 18:00 and 21:00. The dispatcher runs every 15 minutes from 09:00 to 21:45 (`*/15 9-21 * * *`,
52 runs a day) and stops catching up at 22:00. The sidecar's deployed caps rise with it:
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
- **`MIN_GAP_MIN` 170 to 160.** Runs fall on the quarter hour, so a 170-minute gap acted as 180
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

## Amendment 2026-10-27 (second): a refused clip is retried once at a later slot

This supersedes the "set aside on the first refusal" row of the rejection mapping above.

**Evidence.** The sidecar refused `15_Varia RearVue 820` at 2026-10-27 15:00 SAST (502
`publish_rejected`, status code 5). The same clip, with the same caption and tags, posted when it
was re-sent at 16:58 SAST (V1 above). Since 2026-10-25 about 4 uploads were refused and 6 posted.
Refusals are therefore at least partly intermittent, and setting a clip aside at its first
refusal would lose clips that post on a second try.

**Rule.** Log Results counts TikTok refusals per clip (`refusals` in
`.state/retryable-failures.json`, keyed by `<job>/<file>`). Only a non-throttle 502
`publish_rejected` counts; the throttle message and `signature_failed` stay `deferred` and do not.

| Refusal of the clip | Effect |
|---|---|
| 1st | Clip released back to the pool; a later slot (not necessarily the next) retries it. Row status `refused_retry`; a Telegram notice "refusal 1 of 2" (informational) |
| 2nd | Claim `needs_you`, set aside as before; safety alert "TikTok refused to publish it twice", with the release command |

- **Why 2.** One retry recovers an intermittent refusal; a second refusal of the same clip points
  at the clip, and further retries would spend attempts the other clips need. The sidecar also
  pauses posting for 12 hours after 2 failed attempts in a row.
- **Why the slot stays used.** At most one upload attempt per slot keeps the posting rhythm and
  the spacing between attempts; freeing the slot would re-attempt within 15 minutes, which is
  closer to the throttling pattern and walks straight into the sidecar's 12-hour pause.
- **Lifetime of the count.** It is dropped once the clip's outcome is final (posted,
  posted_elsewhere, set aside, ambiguous) and kept while the clip is only released (sidecar busy,
  cookie, daily cap, deferred). Dry runs never read or change it. Only the newest 50 clips are kept.
- The `needs_you` streak is unchanged: a refusal neither counts toward it nor ends it.

## Related

- `projects/reelsmith-social-publish/README.md`: flow, secrets, watchdog, go-live runbook.
- Reelsmith ADR-012 (linked above): the full record.
