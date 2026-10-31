#!/usr/bin/env bash
# Disclosure sweep: refuse to publish identifiers that should not be in a PUBLIC repo.
#
#   scripts/disclosure-sweep.sh <file> [file...]
#   scripts/disclosure-sweep.sh $(git diff --name-only origin/main...HEAD)
#
# Exit 0 = clean. Exit 1 = at least one hit, printed as file:line:match.
#
# KNOWN LIMITS, stated rather than discovered later. The topic rule fails CLOSED: any
# five-plus-character value after the word "topic" is a hit, so ordinary prose can trip it
# and the allow-list below carries the words seen so far. A miss would leak an alert topic;
# a false positive costs a reader a moment, so the trade runs this way deliberately. The
# email rule matches any two-to-24 character top-level domain rather than a fixed list, minus
# the RFC 2606 reserved names, which cannot be real mailboxes and are allowed by name. The
# phone rule allows the 000 000X synthetic form used in test payloads, and nothing wider. The
# IPv6 rule needs two hex groups before the double colon, which means a single-group form
# such as fe80::1 is not caught by that branch; the Tailscale prefix rule covers the case
# that actually occurs here.
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
# Run it locally and in review. Do not add it to the self-hosted deploy workflow on
# `pull_request`; but keeping it out of CI is not a fork-PR defence either: for pull_request
# events GitHub runs the workflow files from the PR's own merge ref, so a fork PR can bring its
# own workflow that targets the self-hosted runner (which holds cluster credentials), whatever
# the workflows on main say. The real controls are the repo setting Actions > General >
# "Require approval for all external contributors" and detaching the self-hosted runner from
# this public repo; both are owner actions listed in projects/reelsmith-social-publish/README.md.

set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <file> [file...]" >&2; exit 2; }

# Deny patterns, one per line, case-insensitive extended regex.
DENY='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}
iam\.gserviceaccount\.com|prudentia-n8n
(ntfy\.sh/[A-Za-z0-9_-]{4,}|topic["'"'"'`=:/[:space:]]+[A-Za-z0-9][A-Za-z0-9_-]{4,})
([0-9]{1,3} ?\. ?){3}[0-9]{1,3}
[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
homelab\.local|homelab-tailscale|100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local|fd7a:[0-9a-f:]{4,}|\b[0-9a-f]{1,4}(:[0-9a-f]{1,4})+::([0-9a-f]{1,4}(:[0-9a-f]{1,4})*)?\b
(kv/)?secret/n8n/[a-z]+/[a-z-]+
(id|credentialsId|workflowId)["'"'"' :=]+[A-Za-z0-9]{16}
\+ ?27[ -]?[0-9][0-9 -]{7,}
eyJ[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY|[A-Za-z0-9+/]{60,}={0,2}
[0-9]{8,10}:[A-Za-z0-9_-]{35}
sessionid[=: "'"'"']+[0-9a-f]{32}'

# npm lockfile integrity lines are package hashes, not secrets. A line that is exactly
# `"integrity": "sha512-<base64>",` and nothing else is blanked before scanning (line numbers
# are kept); anything more on the line, or any other line of the lockfile, is still scanned.
INTEGRITY_LINE='^[[:space:]]*"integrity": "sha512-[A-Za-z0-9+/]+={0,2}",?[[:space:]]*$'

# Allow: already published in this repository, or structurally safe. Matched against the HIT
# TEXT, not the line, so an allowed token cannot smuggle a denied one on the same line.
ALLOW='^n8n-sheets@prudentia-n8n\.iam\.gserviceaccount\.com$
^iam\.gserviceaccount\.com$
^prudentia-n8n$
^n8n\.homelab\.local$
^homelab\.local$
^127\.0\.0\.1$
^0\.0\.0\.0$
^(10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0|100\.64\.0\.0|169\.254\.0\.0)$
^topic[ :]+(remains|archival|follow-up|end-to-end|above|below|here|itself|covered|discussed|these|those|which|rotation|value|owner|names?|name)$
^topic[ :]+[0-9]{4}-[0-9]{2}-[0-9]{2}$
^[A-Za-z0-9._%+-]+@example\.(com|net|org)$
^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)*(test|example|invalid|localhost)$
^\+27 [0-9]{2} 000 000[0-9] ?$
^kv/secret/n8n/(live|local)/[a-z-]+$
^secret/n8n/(live|local)/[a-z-]+$
^0f0cddada0abb51c4fe6126c645088bdd49ac5ecc125bc302debbb7a56a045be$
^3ad31c4106510be5f20e130125bbc11380833132cad8a3c2b426b01171d2f876$
^4a61322ac1103a0e3aea2a61ef1718422a48fa046441f299d71e660a3bc71ae9$
^f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36$
^73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662$
^5fb5438b300a430f0636b60924939defb84f965b15ad7ae16acf5a2ac9c9e5c3$'

rc=0
for f in "$@"; do
  if [ ! -f "$f" ]; then echo "$f: NOT FOUND (wrong directory? deleted file?)" >&2; rc=1; continue; fi
  # Skip only this script at its own repo path -- a same-named file elsewhere must still be scanned.
  case "$f" in scripts/disclosure-sweep.sh|./scripts/disclosure-sweep.sh|*/n8n-self-hosting/scripts/disclosure-sweep.sh) continue ;; esac
  while IFS= read -r pat; do
    [ -n "$pat" ] || continue
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      # grep -no emits LINE:MATCH for a single file, so strip exactly one field. Stripping
      # twice ate a colon inside the match and made every anchored allow entry unreachable.
      text=${hit#*:}
      echo "$text" | grep -qiE "$ALLOW" && continue
      echo "$f:$hit"
      rc=1
    done < <(sed -E "s#${INTEGRITY_LINE}##" "$f" | grep -noEi "$pat" 2>/dev/null)
  done <<< "$DENY"
done

if [ "$rc" -eq 0 ]; then echo "disclosure-sweep: clean ($# file(s))"; else echo "disclosure-sweep: FAIL"; fi
exit "$rc"
