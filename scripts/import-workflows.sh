#!/usr/bin/env bash
# Import workflow JSON from this repo into the running n8n instance.
#
# WHY THIS EXISTS: nothing else does it. ArgoCD's source path is `helm/n8n-application`,
# and CI only triggers on `helm/**` and `argocd/**` and only applies an Application
# manifest. A workflow JSON committed anywhere in this repo is INERT until imported.
# Before this script the documented process was "n8n UI -> Import from File", by hand.
#
# Usage:
#   scripts/import-workflows.sh templates/lead-to-client-pipeline
#   scripts/import-workflows.sh projects/gtm-email-sender --dry-run
#
# Looks for <dir>/workflows/*.json. Run from a machine with kubectl access to the
# cluster (or on the node itself, where kubectl is `microk8s kubectl`).
#
# Credential ids in committed JSON must be placeholders, never a live n8n id.
set -euo pipefail

NS="${N8N_NAMESPACE:-n8n-live}"
DEPLOY="${N8N_DEPLOYMENT:-deploy/n8n}"
CONTAINER="${N8N_CONTAINER:-n8n}"
DRY_RUN=0
DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *)  DIR="$arg" ;;
  esac
done

[ -n "$DIR" ] || { echo "usage: $0 <dir-containing-workflows/> [--dry-run]" >&2; exit 2; }

# Prefer `microk8s kubectl` FIRST. On this host the plain `kubectl` on PATH is a
# `sudo microk8s kubectl` wrapper (see /usr/local/bin/kubectl) that blocks forever
# waiting for a sudo password in any non-interactive shell (ssh, CI). Every other
# script in this repo drives the cluster through `microk8s kubectl` for the same
# reason -- match that instead of trusting whatever `kubectl` resolves to.
if microk8s kubectl version --client >/dev/null 2>&1; then
  KUBECTL="microk8s kubectl"
elif command -v kubectl >/dev/null 2>&1; then
  KUBECTL="kubectl"
else
  echo "no usable kubectl found (tried 'microk8s kubectl' and 'kubectl')" >&2
  exit 1
fi

SRC="${DIR%/}/workflows"
[ -d "$SRC" ] || { echo "no such directory: $SRC" >&2; exit 1; }

shopt -s nullglob
FILES=("$SRC"/*.json)
[ ${#FILES[@]} -gt 0 ] || { echo "no .json files in $SRC" >&2; exit 1; }

# Fail before touching the cluster if any file is malformed or not import-clean.
# n8n overwrites by matching `id`, so a stray `id` from an API export silently
# clobbers an unrelated workflow. Templates must carry name/nodes/connections only.
for f in "${FILES[@]}"; do
  python3 - "$f" <<'PY'
import json, re, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception as e:
    sys.exit(f"{p}: invalid JSON: {e}")
if not isinstance(d, dict):
    sys.exit(f"{p}: top level must be an object, got {type(d).__name__}")
for k in ("name", "nodes", "connections"):
    if k not in d:
        sys.exit(f"{p}: missing required key '{k}'")
banned = [k for k in ("id", "shared", "activeVersion", "versionId", "versionCounter",
                      "activeVersionId", "triggerCount", "meta", "pinData") if k in d]
if banned:
    sys.exit(f"{p}: remove API-export keys before import: {', '.join(banned)}")
if len(d["name"]) > 128:
    sys.exit(f"{p}: name exceeds n8n's 128-char limit")
seen = set()
for n in d["nodes"]:
    for k in ("name", "type", "typeVersion", "position"):
        if k not in n:
            sys.exit(f"{p}: node {n.get('name','?')} missing '{k}'")
    if n["name"] in seen:
        sys.exit(f"{p}: duplicate node name {n['name']!r}")
    seen.add(n["name"])
    # A real n8n credential id is 16 alphanumeric characters, e.g. `AAAAAAAAAAAAAAAA`. Pinning
    # one leaks an instance-specific secret handle into git AND silently binds the
    # imported workflow to whatever that id happens to be on the target instance.
    # Match on the SHAPE, not on a REPLACE_ prefix: named placeholders like
    # `reelsmith-youtube` are legitimate and must keep validating.
    for ctype, c in (n.get("credentials") or {}).items():
        if re.fullmatch(r"[A-Za-z0-9]{16}", str(c.get("id", ""))):
            sys.exit(f"{p}: node {n['name']!r} pins live credential id {c['id']} ({ctype}); use a REPLACE_* placeholder")
for src in d["connections"]:
    if src not in seen:
        sys.exit(f"{p}: connection from unknown node {src!r}")
    for outs in d["connections"][src].get("main", []):
        for c in outs or []:
            if c["node"] not in seen:
                sys.exit(f"{p}: connection to unknown node {c['node']!r}")
orphans = seen - {src for src in d["connections"]} - {
    c["node"] for src in d["connections"]
    for outs in d["connections"][src].get("main", []) for c in (outs or [])}
orphans = {o for o in orphans if not any(
    t in next(n["type"] for n in d["nodes"] if n["name"] == o)
    for t in ("stickyNote", "Trigger", "trigger"))}
if orphans:
    print(f"  WARN {p}: unreachable node(s): {', '.join(sorted(orphans))}")
print(f"  ok   {p}  ({len(d['nodes'])} nodes)")
PY
done

echo "validated ${#FILES[@]} workflow file(s)"
# NOT `[ cond ] && { ...; }` -- that returns 1 when the condition is false, and
# under `set -e` a non-zero compound at statement level aborts the script, so the
# import would silently never run.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: not importing"
  exit 0
fi

# `kubectl exec` accepts a workload reference directly, and stdin redirection
# replaces `kubectl cp`, so no pod-name lookup is needed at all. The previous
# version resolved the pod through a nested command substitution that returned
# non-zero and, under `set -e`, aborted before importing anything.
TMP="/tmp/n8n-import-$$"
$KUBECTL -n "$NS" exec "$DEPLOY" -c "$CONTAINER" -- mkdir -p "$TMP"
for f in "${FILES[@]}"; do
  base=$(basename "$f")
  $KUBECTL -n "$NS" exec -i "$DEPLOY" -c "$CONTAINER" -- sh -c "cat > $TMP/$base" < "$f"
done

# --separate reads every *.json in the directory. n8n overwrites on matching `id`;
# templates carry none, so each run CREATES new workflows. Import once, then manage
# by exporting back into the repo.
$KUBECTL -n "$NS" exec "$DEPLOY" -c "$CONTAINER" -- n8n import:workflow --separate --input="$TMP"
$KUBECTL -n "$NS" exec "$DEPLOY" -c "$CONTAINER" -- rm -rf "$TMP"

echo
echo "imported. Workflows are created INACTIVE -- activate them in the UI after"
echo "attaching credentials, and set the error workflow on each."
