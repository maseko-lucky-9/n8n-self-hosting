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
   newest job first.
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

## Related

- `projects/reelsmith-social-publish/README.md`: flow, secrets, watchdog, go-live runbook.
- Reelsmith ADR-012 (linked above): the full record.
