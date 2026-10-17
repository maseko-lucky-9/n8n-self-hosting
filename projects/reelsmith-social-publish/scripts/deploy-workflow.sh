#!/usr/bin/env bash
# Deploy workflow/reelsmith-social-publish.json to the live n8n through its public API,
# or roll it back. Run from the Mac; nothing here is run by CI.
#
# Usage (go-live runbook):
#   step 5  scripts/deploy-workflow.sh --workflow-id ID --dry-run --no-publish
#   step 6  scripts/deploy-workflow.sh --workflow-id ID --dry-run --simulate auth_invalid --no-publish
#   step 7  scripts/deploy-workflow.sh --workflow-id ID --live
#   rollback scripts/deploy-workflow.sh --workflow-id ID --deactivate
# Steps 5 and 6 save an unpublished draft that you execute by hand from the n8n editor; a
# published dry-run workflow would run 36 dry runs a day. Only step 7 (--live) publishes.
#
#   --dry-run      deploy with DRY_RUN=true (the committed default): every run is a sidecar dry run
#   --live         deploy with DRY_RUN=false, patched IN MEMORY only (git keeps true)
#   --simulate X   dry-run only: also send `simulate=X` (Contract v1 test hook) to drive Log Results
#                  through the 401 alert (auth_invalid) or the retry path (busy)
#   --no-publish   save as a draft only (execute it by hand from the editor); always with --dry-run
#   --deactivate   rollback: unpublish. Do this BEFORE restoring an old copy; never PUT a backup
#                  while the workflow is published.
#
# The n8n API key is read from stdin, never argv or env. Paste it at the prompt, or pipe it:
#   pbpaste | scripts/deploy-workflow.sh --workflow-id ID --dry-run --no-publish
# The workflow ID is the one in the n8n editor URL (/workflow/<ID>).
#
# What it does:
#   1. ssh -L to the homelab, which runs `microk8s kubectl port-forward svc/n8n-application`, so
#      the API is reached on 127.0.0.1 without the ingress basic auth.
#   2. GET the live workflow -> backups/<UTC stamp>-<ID>.json (0600, gitignored). Refuses unless
#      its name is "Reelsmith Social Publish".
#   3. PUT /workflows/ID?publishIfActive=false with ONLY {name,nodes,connections,settings}, then
#      POST /workflows/ID/publish {versionId} with the versionId the PUT returned.
#      --deactivate: POST /workflows/ID/unpublish instead.
#
# Verified against the n8n@2.39.8 source (read-only, 2026-10-17):
#   packages/cli/src/public-api/v1/controllers/workflows.public.controller.ts
#     PUT /:workflowId (?publishIfActive, default true), POST /:workflowId/publish {versionId,
#     name, description}, POST /:workflowId/unpublish (/activate and /deactivate are deprecated
#     aliases); the update response carries `versionId`.
#   packages/@n8n/api-types/src/dto/workflows/{update-workflow-public,base-workflow-public}.dto.ts
#     strict body and strict settings keys (no maxConcurrency); nodes may omit `id`
#     (WorkflowService.update calls addNodeIds).
#   packages/cli/src/services/api-key-auth.strategy.ts: header `x-n8n-api-key`.
# [UNVERIFIED] the public API is enabled on this instance and served by svc/n8n-application:5678
#   under /api/v1; the key carries workflow:read, workflow:update, workflow:activate and
#   workflow:deactivate; the ssh user can run `microk8s kubectl` and `timeout` on the homelab.
set -euo pipefail
umask 077

case $- in
  *x*) echo "refusing to run under xtrace: it would print the API key" >&2; exit 2 ;;
esac

SSH_HOST="${N8N_SSH_HOST:-homelab}"
NAMESPACE="n8n-live"
SERVICE="svc/n8n-application"
LOCAL_PORT="${N8N_LOCAL_PORT:-15678}"
WORKFLOW_NAME="Reelsmith Social Publish"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORKFLOW_FILE="$PROJECT_DIR/workflow/reelsmith-social-publish.json"
BACKUP_DIR="$PROJECT_DIR/backups"

usage() { sed -n '2,/^# What it does:/p' "$0" | sed '$d' >&2; exit 2; }
die() { echo "deploy-workflow: $*" >&2; exit 1; }

WORKFLOW_ID="" MODE="" SIMULATE="" PUBLISH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --workflow-id) [ $# -ge 2 ] || usage; WORKFLOW_ID="$2"; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --live) MODE="live"; shift ;;
    --deactivate) MODE="deactivate"; shift ;;
    --simulate) [ $# -ge 2 ] || usage; SIMULATE="$2"; shift 2 ;;
    --no-publish) PUBLISH=0; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$MODE" ] || usage
[[ "$WORKFLOW_ID" =~ ^[A-Za-z0-9]{8,32}$ ]] || die "--workflow-id is required (letters and digits)"
case "$SIMULATE" in
  "") ;;
  auth_invalid|busy) [ "$MODE" = "dry-run" ] || die "--simulate only works with --dry-run" ;;
  *) die "--simulate must be auth_invalid or busy" ;;
esac
for bin in node curl ssh; do command -v "$bin" >/dev/null || die "$bin not found"; done
[ -f "$WORKFLOW_FILE" ] || die "missing $WORKFLOW_FILE"

WORK="$(mktemp -d)"
TUNNEL_PID=""
cleanup() {
  if [ -n "$TUNNEL_PID" ]; then kill "$TUNNEL_PID" 2>/dev/null || true; fi
  exec 3>&- 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# 1. Payload, built before anything touches the network.
PAYLOAD="$WORK/payload.json"
if [ "$MODE" != "deactivate" ]; then
  node - "$WORKFLOW_FILE" "$MODE" "$SIMULATE" > "$PAYLOAD" <<'JS'
const fs = require('fs');
const [file, mode, simulate] = process.argv.slice(2);
const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
const pick = wf.nodes.find((n) => n.name === 'Pick Due Clip');
const upload = wf.nodes.find((n) => n.name === 'TikTok Sidecar Upload');
if (!pick || !upload) throw new Error('workflow JSON lacks Pick Due Clip / TikTok Sidecar Upload');
const SWITCH = 'const DRY_RUN = true;';
if (pick.parameters.jsCode.split(SWITCH).length !== 2) throw new Error('expected exactly one `' + SWITCH + '`');
if (mode === 'live') pick.parameters.jsCode = pick.parameters.jsCode.replace(SWITCH, 'const DRY_RUN = false;');
if (simulate) upload.parameters.bodyParameters.parameters.push({ parameterType: 'formData', name: 'simulate', value: simulate });
const { name, nodes, connections, settings } = wf;
process.stdout.write(JSON.stringify({ name, nodes, connections, settings }));
JS
fi

# 2. API key from stdin. Kept in a shell variable only; curl gets it through `-K -` (its stdin),
#    fed by the printf builtin, so it never appears in any process's argv or environment.
if [ -t 0 ]; then printf 'n8n API key (input hidden): ' >&2; fi
IFS= read -rs N8N_API_KEY || true
if [ -t 0 ]; then printf '\n' >&2; fi
[[ "$N8N_API_KEY" =~ ^[A-Za-z0-9._-]{20,}$ ]] || die "no usable API key on stdin"

# 3. Tunnel: local 127.0.0.1:LOCAL_PORT -> homelab 127.0.0.1:LOCAL_PORT -> port-forward -> n8n.
#    The remote side ends the port-forward when the ssh session's stdin closes (`cat` returns),
#    and `timeout` is the backstop. fd 3 is a FIFO held open read-write, so ssh's stdin never
#    hits EOF while this script runs.
mkfifo "$WORK/keepalive"
exec 3<>"$WORK/keepalive"
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${LOCAL_PORT}" "$SSH_HOST" \
  "timeout 900 microk8s kubectl -n $NAMESPACE port-forward --address 127.0.0.1 $SERVICE ${LOCAL_PORT}:5678 >/dev/null 2>&1 & pf=\$!; cat >/dev/null; kill \$pf 2>/dev/null" \
  <&3 >"$WORK/tunnel.log" 2>&1 &
TUNNEL_PID=$!

BASE="http://127.0.0.1:${LOCAL_PORT}"
ready=0
for _ in $(seq 1 30); do
  kill -0 "$TUNNEL_PID" 2>/dev/null || break
  if curl -s -o /dev/null --max-time 2 "$BASE/healthz"; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  grep -v -i 'authorized\|^\*' "$WORK/tunnel.log" >&2 || true
  die "tunnel to $SERVICE did not come up on 127.0.0.1:$LOCAL_PORT (port in use? set N8N_LOCAL_PORT)"
fi

# api METHOD PATH BODY_FILE|"" OUT_FILE -> prints the HTTP status
api() {
  local method="$1" path="$2" body="$3" out="$4"
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" --max-time 60 -H 'Accept: application/json')
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
  printf 'header = "X-N8N-API-KEY: %s"\n' "$N8N_API_KEY" | curl -K - "${args[@]}" "$BASE/api/v1$path"
}
json_field() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=d[process.argv[2]]; process.stdout.write(v==null?"":String(v));' "$1" "$2"; }
snippet() { head -c 300 "$1" | tr -d '\r'; echo; }

# 4. Backup of the live copy, always first.
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${WORKFLOW_ID}.json"
code="$(api GET "/workflows/$WORKFLOW_ID" "" "$BACKUP")"
chmod 600 "$BACKUP"
if [ "$code" != "200" ]; then
  echo "GET answered HTTP $code: $(snippet "$BACKUP")" >&2
  rm -f "$BACKUP"
  die "no backup taken; nothing changed"
fi
[ "$(json_field "$BACKUP" name)" = "$WORKFLOW_NAME" ] || die "workflow $WORKFLOW_ID is not \"$WORKFLOW_NAME\"; nothing changed"
echo "backup: ${BACKUP#"$PROJECT_DIR"/} (active=$(json_field "$BACKUP" active), versionId=$(json_field "$BACKUP" versionId))"

if [ "$MODE" = "deactivate" ]; then
  code="$(api POST "/workflows/$WORKFLOW_ID/unpublish" "" "$WORK/unpublish.json")"
  [ "$code" = "200" ] || die "unpublish answered HTTP $code: $(snippet "$WORK/unpublish.json")"
  [ "$(json_field "$WORK/unpublish.json" active)" = "false" ] || die "unpublish returned but the workflow is still active"
  echo "unpublished: $WORKFLOW_NAME is inactive"
  exit 0
fi

# 5. Save the new version as a draft on top of whatever is published.
code="$(api PUT "/workflows/$WORKFLOW_ID?publishIfActive=false" "$PAYLOAD" "$WORK/put.json")"
[ "$code" = "200" ] || die "PUT answered HTTP $code: $(snippet "$WORK/put.json")"
VERSION_ID="$(json_field "$WORK/put.json" versionId)"
[[ "$VERSION_ID" =~ ^[A-Za-z0-9-]{8,64}$ ]] || die "PUT response has no usable versionId"
echo "saved: versionId=$VERSION_ID (DRY_RUN=$([ "$MODE" = live ] && echo false || echo true)${SIMULATE:+, simulate=$SIMULATE})"

if [ "$PUBLISH" -eq 0 ]; then
  echo "not published (--no-publish); run it from the editor"
  exit 0
fi

# 6. Publish exactly the version just saved.
printf '{"versionId":"%s"}' "$VERSION_ID" > "$WORK/publish-body.json"
code="$(api POST "/workflows/$WORKFLOW_ID/publish" "$WORK/publish-body.json" "$WORK/publish.json")"
[ "$code" = "200" ] || die "publish answered HTTP $code: $(snippet "$WORK/publish.json")"
[ "$(json_field "$WORK/publish.json" active)" = "true" ] || die "publish returned but the workflow is not active"
[ "$(json_field "$WORK/publish.json" activeVersionId)" = "$VERSION_ID" ] \
  || die "published version is not $VERSION_ID; check the editor"
echo "published: $WORKFLOW_NAME versionId=$VERSION_ID"
