#!/usr/bin/env bash
# Deploy workflow/reelsmith-social-publish.json to the live n8n through its public API,
# or roll it back. Run from the Mac; nothing here is run by CI.
#
# Usage (go-live runbook):
#   step 5   scripts/deploy-workflow.sh --workflow-id ID --dry-run
#   step 6   scripts/deploy-workflow.sh --workflow-id ID --dry-run --simulate auth_invalid
#   step 7   scripts/deploy-workflow.sh --workflow-id ID --live
#   rollback scripts/deploy-workflow.sh --workflow-id ID --deactivate
# A dry-run deploy is SAVED only, never published: you execute it by hand from the n8n editor,
# so it never runs on the schedule. --live saves and publishes in one go, so no DRY_RUN=false
# draft is left behind (unless the publish call itself fails: the script says so; re-run it).
# There is no --no-publish.
#
#   --dry-run      save with DRY_RUN=true (the committed default): every run is a sidecar dry run
#   --live         save with DRY_RUN=false, patched IN MEMORY only (git keeps true), and publish
#   --simulate X   dry-run only: also send `simulate=X` (Contract v1 test hook) to drive Log Results
#                  through the 401 alert (auth_invalid) or the retry path (busy)
#   --deactivate   rollback: unpublish. Do this BEFORE restoring an old copy; never PUT a backup
#                  while the workflow is published.
#   N8N_FORWARD_PORT (default 15678): the loopback port kubectl port-forward binds on the homelab.
#   N8N_SSH_HOST (default homelab-tunnel): the ssh alias. The deploy connects as svc-ai-agent
#                  (alias homelab-tunnel): sshd allows TCP forwarding only for that user
#                  (`Match User svc-ai-agent AllowTcpForwarding local`); the usual `homelab`
#                  alias (user dev) gets "administratively prohibited" for -L.
#
# The n8n API key is read from stdin, never argv or env. Paste it at the prompt, or pipe it:
#   pbpaste | scripts/deploy-workflow.sh --workflow-id ID --dry-run
# The workflow ID is the one in the n8n editor URL (/workflow/<ID>).
#
# What it does:
#   1. ssh (as svc-ai-agent) forwards a Unix socket inside this run's 0700 temp dir to the homelab, where
#      `microk8s kubectl port-forward svc/n8n-application` listens on 127.0.0.1 (no ingress basic
#      auth, and no local TCP port another process could already hold). The API key is sent only
#      after the remote port-forward reported its own bind, n8n's /healthz/readiness answered
#      {"status":"ok"} over that socket, and the ssh process is still alive.
#   2. GET the live workflow -> backups/<UTC stamp>-<ID>.json (0600, gitignored). Refuses unless
#      its name is "Reelsmith Social Publish".
#   3. PUT /workflows/ID?publishIfActive=false with ONLY {name,nodes,connections,settings}; with
#      --live, then POST /workflows/ID/publish {versionId} with the versionId the PUT returned.
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
#   packages/cli/src/abstract-server.ts: GET /healthz/readiness -> {"status":"ok"} once the DB is
#     connected and migrated.
# Verified on the homelab (2026-10-18): svc-ai-agent can forward, and run `microk8s kubectl`,
#   `timeout` and `setsid`; kubectl prints "Forwarding from 127.0.0.1:<port>" once bound (the
#   readiness JSON came back through the socket); the remote /bin/sh is dash; `microk8s kubectl`
#   is a chain of non-exec bash wrappers.
# [UNVERIFIED] the public API is enabled on this instance under /api/v1; the key carries
#   workflow:read, workflow:update, workflow:activate and workflow:deactivate.
set -euo pipefail
umask 077

case $- in
  *x*) echo "refusing to run under xtrace: it would print the API key" >&2; exit 2 ;;
esac

SSH_HOST="${N8N_SSH_HOST:-homelab-tunnel}"
NAMESPACE="n8n-live"
SERVICE="svc/n8n-application"
FORWARD_PORT="${N8N_FORWARD_PORT:-15678}"
WORKFLOW_NAME="Reelsmith Social Publish"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORKFLOW_FILE="$PROJECT_DIR/workflow/reelsmith-social-publish.json"
BACKUP_DIR="$PROJECT_DIR/backups"

usage() { sed -n '2,/^# What it does:/p' "$0" | sed '$d' >&2; exit 2; }
die() { echo "deploy-workflow: $*" >&2; exit 1; }

WORKFLOW_ID="" MODE="" SIMULATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --workflow-id) [ $# -ge 2 ] || usage; WORKFLOW_ID="$2"; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --live) MODE="live"; shift ;;
    --deactivate) MODE="deactivate"; shift ;;
    --simulate) [ $# -ge 2 ] || usage; SIMULATE="$2"; shift 2 ;;
    --no-publish) die "--no-publish was removed: --dry-run never publishes, --live always does" ;;
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
# Both values reach a remote command line or ssh's argv: validate before any use.
if ! [[ "$FORWARD_PORT" =~ ^[0-9]{4,5}$ ]] || [ "$FORWARD_PORT" -lt 1024 ] || [ "$FORWARD_PORT" -gt 65535 ]; then
  die "N8N_FORWARD_PORT must be a port number from 1024 to 65535"
fi
[[ "$SSH_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || die "N8N_SSH_HOST must be a plain host alias"
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

# 3. Tunnel: $SOCK (Unix socket, 0700 dir) -> ssh -> homelab 127.0.0.1:FORWARD_PORT -> kubectl
#    port-forward -> n8n. The WHOLE remote command runs under `timeout 900`; kubectl's own output
#    comes back into tunnel.log, and if it exits for any reason the remote shell says so there.
#    `microk8s kubectl` is a chain of bash wrappers that do not exec the real kubectl, so killing
#    the PID `$!` would only kill the top wrapper and leave kubectl holding the port (every run
#    used to leak one). So the port-forward is started with `setsid`, as its own process group,
#    and stopped with ONE group kill when the ssh session's stdin closes (`cat` returns) or the
#    remote shell exits or is signalled (timeout's TERM included). fd 3 is a FIFO held open
#    read-write, so ssh's stdin never hits EOF while this script runs.
SOCK="$WORK/n8n.sock"
[ ! -e "$SOCK" ] || die "$SOCK already exists"
mkfifo "$WORK/keepalive"
exec 3<>"$WORK/keepalive"
# A background job's stdin is /dev/null, so the watcher reads the session's stdin through fd 3.
# The remote /bin/sh is dash: there `kill -TERM -- -PID` silently fails (no group is killed),
# while `kill -s TERM -- -PID` works. That failure does not show on macOS, whose /bin/sh is
# bash; deploy-workflow.selfcheck.js runs this command under dash to catch it, and the form was
# verified end to end on the homelab (nothing survived, the port was free).
REMOTE="timeout 900 sh -c 'exec 3<&0; setsid microk8s kubectl -n $NAMESPACE port-forward --address 127.0.0.1 $SERVICE $FORWARD_PORT:5678 & pf=\$!; stop() { kill -s TERM -- -\$pf 2>/dev/null; }; trap stop EXIT HUP TERM INT; (cat <&3 >/dev/null; stop) >/dev/null 2>&1 & wait \$pf; echo \"deploy-workflow: port-forward exited (\$?)\" >&2'"
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=10 \
  -T -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o ControlMaster=no -o ControlPath=none \
  -L "$SOCK:127.0.0.1:$FORWARD_PORT" "$SSH_HOST" "$REMOTE" \
  <&3 >"$WORK/tunnel.log" 2>&1 &
TUNNEL_PID=$!

tunnel_alive() {
  kill -0 "$TUNNEL_PID" 2>/dev/null && ! grep -q 'deploy-workflow: port-forward exited' "$WORK/tunnel.log"
}
tunnel_died() {
  grep -v -i 'authorized\|^\*' "$WORK/tunnel.log" >&2 || true
  die "the ssh tunnel or the remote port-forward to $SERVICE died (\"address already in use\" above means a stale port-forward still holds $FORWARD_PORT on the homelab; set N8N_FORWARD_PORT)"
}

# Ready = kubectl reported binding OUR port (so nothing else held it), the socket is ours, n8n's
# readiness JSON came back through it, and both ends are still alive. Only then the key is sent.
ready=0
for _ in $(seq 1 30); do
  tunnel_alive || break
  if grep -q "Forwarding from 127.0.0.1:$FORWARD_PORT " "$WORK/tunnel.log" && [ -S "$SOCK" ] && [ -O "$SOCK" ]; then
    health="$(curl -fsS --max-time 3 --unix-socket "$SOCK" http://localhost/healthz/readiness 2>/dev/null || true)"
    if [ "$health" = '{"status":"ok"}' ]; then ready=1; break; fi
  fi
  sleep 1
done
if [ "$ready" -ne 1 ] || ! tunnel_alive; then tunnel_died; fi

# api METHOD PATH BODY_FILE|"" OUT_FILE -> prints the HTTP status
api() {
  local method="$1" path="$2" body="$3" out="$4"
  tunnel_alive || tunnel_died
  local args=(-sS -o "$out" -w '%{http_code}' -X "$method" --max-time 60 --unix-socket "$SOCK"
    -H 'Accept: application/json')
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
  printf 'header = "X-N8N-API-KEY: %s"\n' "$N8N_API_KEY" | curl -K - "${args[@]}" "http://localhost/api/v1$path"
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

if [ "$MODE" = "dry-run" ]; then
  echo "saved, not published: open the workflow in the n8n editor and execute it by hand"
  exit 0
fi

# 6. --live: publish exactly the version just saved.
printf '{"versionId":"%s"}' "$VERSION_ID" > "$WORK/publish-body.json"
code="$(api POST "/workflows/$WORKFLOW_ID/publish" "$WORK/publish-body.json" "$WORK/publish.json")"
[ "$code" = "200" ] || die "publish answered HTTP $code: $(snippet "$WORK/publish.json")"
[ "$(json_field "$WORK/publish.json" active)" = "true" ] || die "publish returned but the workflow is not active"
[ "$(json_field "$WORK/publish.json" activeVersionId)" = "$VERSION_ID" ] \
  || die "published version is not $VERSION_ID; check the editor"
echo "published: $WORKFLOW_NAME versionId=$VERSION_ID"
