# ADR-0003: Reelsmith uploads are Only me; the owner publishes

- **Status:** Accepted 2026-10-24.
- **Deciders:** owner.
- **Amends:** [ADR-0002](0002-reelsmith-posting-gatekeeper.md), which assumed public posts.

## Context

The owner wants to review and publish each clip by hand. TikTok's official draft route (Content
Posting API `inbox/video/init`) needs a developer app approved for `video.upload` and cannot carry a
caption. The sidecar already posts through the web uploader, whose publish payload has a
visibility field.

## Decision

1. Every upload is posted with visibility **Only me**. The pinned upstream uploader hardcodes
   `"visibility_type": 0` (public) and ignores `--visibility`, so the sidecar image patches that one
   line (the build fails unless the line is found exactly once) and `build_command` passes
   `--visibility=1`.
2. On `posted`, the workflow sends one Telegram notice so the owner can set the clip to Everyone in
   TikTok Studio.
3. Every run that does not post appends its redacted uploader tail to `ledger.failures.jsonl`, so a
   pod restart no longer erases the cause of a failure (six uploads failed unexplained before this).

## Consequences

- Nothing becomes public without the owner. The ledger's `posted` row now means "uploaded as Only me".
- This is a patch to third-party code; an upstream bump must keep the patch or re-verify
  (`tests/test_limits.py` and the Dockerfile check both fail loudly).
- Whether a private-then-public post reaches fewer viewers than a direct public post is not known.
