#!/usr/bin/env bash
# Disclosure sweep: refuse to publish identifiers that should not be in a PUBLIC repo.
#
#   scripts/disclosure-sweep.sh <file> [file...]
#   scripts/disclosure-sweep.sh $(git diff --name-only origin/main...HEAD)
#
# Exit 0 = clean. Exit 1 = at least one hit, printed as file:line:match.
#
# WHY THIS EXISTS: this repository is public. A report or ADR that documents the estate is
# exactly the kind of document that leaks a personal address, an internal IP, a tunnel id or
# an alert topic, because those are the things it is describing. The gate has to outlive the
# pull request that introduced it, so it is committed rather than run once by hand.
#
# TWO DELIBERATE CHOICES:
#   1. `grep`, not `git grep`. On macOS `git grep` does not honour `\b`, so a pattern that
#      matches when tested with grep silently matches nothing under git grep. Verified.
#   2. Deny by default. ALLOW holds only identifiers this repository already publishes; every
#      new one must be added consciously. Adding a line to ALLOW is a review decision.
#
# NOT FOR CI ON `pull_request`: the only workflow here runs on a self-hosted runner, so a fork
# PR that edits this script would execute on the homelab. Run it locally, and in review.

set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <file> [file...]" >&2; exit 2; }

# Deny patterns, one per line, case-insensitive extended regex.
DENY='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|za|net|org|io|dev)
iam\.gserviceaccount\.com|prudentia-n8n
(ntfy\.sh/[A-Za-z0-9_-]{4,}|topic["'"'"'`=:/[:space:]]+[A-Za-z0-9_-]*[0-9_-][A-Za-z0-9_-]*)
([0-9]{1,3} ?\. ?){3}[0-9]{1,3}
[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
homelab\.local|homelab-tailscale|100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local|fd7a:[0-9a-f:]{4,}|[0-9a-f]{1,4}(:[0-9a-f]{1,4})*::[0-9a-f:]*
(kv/)?secret/n8n/[a-z]+/[a-z-]+
(id|credentialsId|workflowId)["'"'"' :=]+[A-Za-z0-9]{16}
\+ ?27[ -]?[0-9][0-9 -]{7,}
eyJ[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY|[A-Za-z0-9+/]{60,}={0,2}'

# Allow: already published in this repository, or structurally safe. Matched against the HIT
# TEXT, not the line, so an allowed token cannot smuggle a denied one on the same line.
ALLOW='^n8n-sheets@prudentia-n8n\.iam\.gserviceaccount\.com$
^iam\.gserviceaccount\.com$
^prudentia-n8n$
^n8n\.homelab\.local$
^homelab\.local$
^127\.0\.0\.1$
^0\.0\.0\.0$
^kv/secret/n8n/(live|local)/[a-z-]+$
^secret/n8n/(live|local)/[a-z-]+$'

rc=0
for f in "$@"; do
  if [ ! -f "$f" ]; then echo "$f: NOT FOUND (wrong directory? deleted file?)" >&2; rc=1; continue; fi
  # Skip only this script at its own repo path -- a same-named file elsewhere must still be scanned.
  case "$f" in scripts/disclosure-sweep.sh|./scripts/disclosure-sweep.sh|*/n8n-self-hosting/scripts/disclosure-sweep.sh) continue ;; esac
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      text=${hit#*:}; text=${text#*:}
      echo "$text" | grep -qE "$ALLOW" && continue
      echo "$f:$hit"
      rc=1
    done < <(grep -noEi "$pat" "$f" 2>/dev/null)
  done <<< "$DENY"
done

if [ "$rc" -eq 0 ]; then echo "disclosure-sweep: clean ($# file(s))"; else echo "disclosure-sweep: FAIL"; fi
exit "$rc"
