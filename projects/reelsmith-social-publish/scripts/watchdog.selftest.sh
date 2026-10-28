#!/usr/bin/env bash
# Self-test for the publish watchdog (manifests/reelsmith-watchdog-cronjob.yaml).
#
# Extracts the container script from the CronJob with python3 + PyYAML and runs
# it against stub `psql`, `wget` and `date` placed first on PATH, asserting every
# alert decision. The watchdog is the Mac-asleep backstop: it sends only "sidecar
# down" and "cookie invalid" (ADR-0002 amendment, 2026-10-28); the stub `psql` is
# there to prove the script no longer touches the database. It also guards the sidecar Deployment's single-process shape
# (one replica, Recreate). Exits non-zero on any failed assertion.
#
#   scripts/watchdog.selftest.sh [cronjob.yaml [test-alert-job.yaml [sidecar-deployment.yaml]]]
#   WATCHDOG_SH=dash scripts/watchdog.selftest.sh   # pick the shell that runs the script (default sh)
#
# The wget stub mimics busybox wget: on a non-2xx answer it exits 1 with
# "server returned error: HTTP/1.1 <code> ..." on stderr (here followed by the
# URL, so a script that echoes wget's stderr leaks the token and fails).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
CRON=${1:-$here/../manifests/reelsmith-watchdog-cronjob.yaml}
JOB=${2:-$here/../manifests/test/reelsmith-watchdog-test-alert-job.yaml}
SIDECAR=${3:-$here/../manifests/tiktok-sidecar-deployment.yaml}
WATCHDOG_SH=${WATCHDOG_SH:-sh}
read -r -a watchdog_sh <<< "$WATCHDOG_SH"   # a command with arguments, e.g. "bash --posix"
export LC_ALL=C

python3 -c 'import yaml' 2>/dev/null || { echo "watchdog.selftest: needs python3 with PyYAML (pip install pyyaml)"; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

# --- extract the script and the manifest's plain env; structural checks -------
python3 - "$CRON" "$JOB" "$SIDECAR" "$work" <<'PY'
import sys, yaml
cron_path, job_path, sidecar_path, out = sys.argv[1:5]
cron = yaml.safe_load(open(cron_path))
job = yaml.safe_load(open(job_path))
sidecar = yaml.safe_load(open(sidecar_path))
problems = []
def check(cond, what):
    if not cond:
        problems.append(what)
spec = cron["spec"]
check(spec.get("schedule") == "45 9 * * *", "CronJob schedule is not '45 9 * * *' (one daily backstop check)")
check(spec.get("timeZone") == "Africa/Johannesburg", "CronJob timeZone is not Africa/Johannesburg")
check(spec.get("startingDeadlineSeconds") == 600, "startingDeadlineSeconds is not 600")
check(spec.get("concurrencyPolicy") == "Forbid", "concurrencyPolicy is not Forbid")
jt = spec["jobTemplate"]["spec"]
check(jt.get("activeDeadlineSeconds") == 300, "activeDeadlineSeconds is not 300")
pod = jt["template"]
check(pod["metadata"]["labels"].get("app.kubernetes.io/component") == "reelsmith-watchdog",
      "pod label app.kubernetes.io/component is not reelsmith-watchdog (NetworkPolicies key on it)")
container = pod["spec"]["containers"][0]
script = container["args"][0]
check("apk " not in script, "script installs packages at runtime (apk)")
env_names = {e["name"] for e in container["env"]}
check(not ({"PGPASSWORD", "WF_ID"} & env_names), "CronJob still carries the database env (PGPASSWORD/WF_ID): the watchdog no longer reads execution_entity")
check("psql" not in script and "execution_entity" not in script, "script still reads the n8n database")
jpod = job["spec"]["template"]
jcontainer = jpod["spec"]["containers"][0]
check(jcontainer.get("command") == container.get("command") and jcontainer.get("args") == container.get("args"),
      "test-alert Job script drifted from the CronJob script")
check(jcontainer.get("image") == container.get("image"), "test-alert Job image differs from the CronJob image")
check({e["name"]: e.get("value") for e in jcontainer.get("env", [])}.get("TEST_ALERT") == "1",
      "test-alert Job does not set TEST_ALERT=1")
check(jpod["metadata"]["labels"].get("app.kubernetes.io/component") == "reelsmith-watchdog",
      "test-alert Job pod label is not reelsmith-watchdog")
# The sidecar is the single gatekeeper: one process, never two pods at once.
check(sidecar["spec"].get("replicas") == 1, "sidecar Deployment replicas is not 1")
check((sidecar["spec"].get("strategy") or {}).get("type") == "Recreate",
      "sidecar Deployment strategy is not Recreate (a rolling update runs two gatekeepers)")
if problems:
    print("\n".join("FAIL [manifest] " + p for p in problems))
    sys.exit(1)
with open(out + "/watchdog.sh", "w") as f:
    f.write(script)
with open(out + "/manifest.env", "w") as f:
    for e in container["env"]:
        if "value" in e:
            f.write("%s=%s\n" % (e["name"], e["value"]))
PY

# --- stubs ---------------------------------------------------------------------
cat > "$work/bin/psql" <<'SH'
#!/bin/sh
# Stub psql: records argv and timeout env, answers $STUB_PSQL_OUT or fails with $STUB_PSQL_RC.
{
  printf 'PGCONNECT_TIMEOUT=%s\n' "${PGCONNECT_TIMEOUT:-}"
  printf 'PGOPTIONS=%s\n' "${PGOPTIONS:-}"
  for a in "$@"; do printf 'ARG %s\n' "$a"; done
} >> "$STUB_DIR/psql.calls"
echo call >> "$STUB_DIR/psql.count"
if [ "${STUB_PSQL_RC:-0}" != 0 ]; then
  echo 'psql: error: connection to server at "postgres-service" failed: timeout expired' >&2
  exit "$STUB_PSQL_RC"
fi
printf '%s\n' "${STUB_PSQL_OUT-0|0|36}"
SH

cat > "$work/bin/wget" <<'SH'
#!/bin/sh
# Stub busybox wget.
out=- post= url= t=
while [ $# -gt 0 ]; do
  case $1 in
    -q) ;;
    -T) t=$2; shift ;;
    -O) out=$2; shift ;;
    --post-data) post=$2; shift ;;
    -*) echo "stub wget: unexpected option $1" >&2; exit 99 ;;
    *) url=$1 ;;
  esac
  shift
done
printf 'T=%s\n' "$t" >> "$STUB_DIR/wget.timeouts"
case $url in
  https://api.telegram.org/bot*/sendMessage)
    n=0
    [ -f "$STUB_DIR/telegram.count" ] && n=$(wc -l < "$STUB_DIR/telegram.count" | tr -d ' ')
    printf '%s' "$post" > "$STUB_DIR/telegram.post.$n"
    echo call >> "$STUB_DIR/telegram.count"
    code=${STUB_TG:-200}; body='{"ok":true}' ;;
  */healthz/session\?account=*)
    echo call >> "$STUB_DIR/sidecar.count"
    code=${STUB_SESSION:-200}; body='{"valid":true,"http_status":200,"checked_at":"2026-10-17T12:45:01+02:00"}' ;;
  */api/stats\?account=*)
    echo call >> "$STUB_DIR/sidecar.count"
    code=${STUB_STATS:-200}
    body=${STUB_STATS_BODY-'{"posted_today":1,"cap":3,"last_success_at":"2026-10-17T12:00:09+02:00","hours_since_success":2.7,"paused_until":null,"posting_enabled":true,"timeout_base_s":240,"timeout_per_mb_s":1.5}'} ;;
  *) echo "stub wget: unexpected URL" >&2; exit 98 ;;
esac
case $code in
  200) [ "$out" = - ] && printf '%s' "$body"; exit 0 ;;
  000) echo "wget: can't connect to remote host (127.0.0.1): Connection refused" >&2; exit 1 ;;
  *) echo "wget: server returned error: HTTP/1.1 $code Stub ($url)" >&2; exit 1 ;;
esac
SH

cat > "$work/bin/date" <<'SH'
#!/bin/sh
# Stub date: "+%H" answers $FAKE_HOUR (and records TZ); anything else is the real date.
for a in "$@"; do
  if [ "$a" = +%H ]; then printf 'TZ=%s\n' "${TZ:-}" >> "$STUB_DIR/date.calls"; printf '%s\n' "$FAKE_HOUR"; exit 0; fi
done
exec /bin/date "$@"
SH
chmod +x "$work/bin/psql" "$work/bin/wget" "$work/bin/date"

# --- harness -------------------------------------------------------------------
FAKE_TOKEN='123456789:FAKE-token_DO-NOT-LEAK'
manifest_env=()
while IFS= read -r line; do manifest_env+=("$line"); done < "$work/manifest.env"
runs=0
state=
fails=0
checks=0
CASE=
OUT=
RC=0

pass() { checks=$((checks + 1)); }
fail() { checks=$((checks + 1)); fails=$((fails + 1)); echo "FAIL [$CASE] $*"; }

# run CASE [VAR=value ...]: fresh stub state, healthy defaults, then the overrides.
run() {
  CASE=$1; shift
  runs=$((runs + 1)); state="$work/state.$runs"; mkdir "$state"
  set +e
  OUT=$(env -i PATH="$work/bin:/usr/local/bin:/usr/bin:/bin" HOME="$work" LC_ALL=C STUB_DIR="$state" \
    "${manifest_env[@]}" TG_TOKEN="$FAKE_TOKEN" TG_CHAT=4242 FAKE_HOUR=15 \
    "$@" "${watchdog_sh[@]}" "$work/watchdog.sh" 2>&1)
  RC=$?
  set -e
  # Every run: no secret and no Telegram URL in the job log.
  case $OUT in *"$FAKE_TOKEN"*|*api.telegram.org*) fail "output leaks the token or URL: $OUT" ;; *) pass ;; esac
  # Every run: the database is never queried.
  if [ -f "$state/psql.count" ]; then fail "script called psql"; else pass; fi
  case $OUT in *"stub wget: unexpected"*) fail "script called wget in an unexpected way: $OUT" ;; *) pass ;; esac
}

count() { if [ -f "$state/$1" ]; then wc -l < "$state/$1" | tr -d ' '; else echo 0; fi; }
expect_rc() { if [ "$RC" = "$1" ]; then pass; else fail "exit $RC, want $1; output: $OUT"; fi; }
expect_sends() {
  local n; n=$(count telegram.count)
  if [ "$n" = "$1" ]; then pass; else fail "$n Telegram message(s), want $1; output: $OUT"; fi
}
expect_count() {
  local n; n=$(count "$1")
  if [ "$n" = "$2" ]; then pass; else fail "$1 = $n, want $2"; fi
}
# Decoded text of the single message sent in this run.
message() {
  [ -f "$state/telegram.post.0" ] || { echo ""; return; }
  python3 -c 'import sys, urllib.parse
q = urllib.parse.parse_qs(sys.stdin.read(), keep_blank_values=True)
print(q.get("text", [""])[0], end="")' < "$state/telegram.post.0"
}
expect_msg() {
  local m; m=$(message)
  case $m in *"$1"*) pass ;; *) fail "message lacks '$1': '$m'" ;; esac
}
expect_msg_is() {
  local m; m=$(message)
  if [ "$m" = "$1" ]; then pass; else fail "message is '$m', want '$1'"; fi
}
expect_no_msg() {
  local m; m=$(message)
  case $m in *"$1"*) fail "message contains '$1': '$m'" ;; *) pass ;; esac
}
# The message is one line of allowlisted characters, the body is fully encoded,
# and chat_id is the numeric id.
expect_clean_message() {
  local f="$state/telegram.post.0"
  [ -f "$f" ] || { fail "no message to inspect"; return; }
  if python3 - "$f" <<'PY'
import re, sys, urllib.parse
raw = open(sys.argv[1]).read()
assert re.fullmatch(r"chat_id=4242&text=[A-Za-z0-9._%-]+", raw), "body not fully encoded: %r" % raw
text = urllib.parse.parse_qs(raw)["text"][0]
assert re.fullmatch(r"[A-Za-z0-9 .,;:()/_-]+", text), "text outside the allowlist: %r" % text
PY
  then pass; else fail "message failed the sanitisation check"; fi
}
expect_out() { case $OUT in *"$1"*) pass ;; *) fail "output lacks '$1': $OUT" ;; esac; }

# --- cases ---------------------------------------------------------------------
# Healthy: exactly one sidecar call (the cached session probe), 10 s timeouts, no alert.
# Failed executions, a stale or paused sidecar and an empty n8n are no longer reported.
run healthy
expect_rc 0; expect_sends 0; expect_out "ok: no alert"; expect_count sidecar.count 1
if [ "$(sort -u "$state/wget.timeouts")" = "T=10" ]; then pass; else fail "a wget call lacks -T 10"; fi
for h in 09 12 15 18 21; do
  run "healthy_$h" FAKE_HOUR=$h
  expect_rc 0; expect_sends 0; expect_count sidecar.count 1
done

# Cookie invalid: 401, and 503 (no cookie on the sidecar).
run cookie_401 STUB_SESSION=401
expect_rc 0; expect_sends 1; expect_msg_is "Reelsmith watchdog: cookie expired - run make refresh-cookies"; expect_clean_message
run no_cookie_503 STUB_SESSION=503
expect_rc 0; expect_sends 1; expect_msg "no cookie on the sidecar - run make refresh-cookies (session check HTTP 503)"
expect_no_msg "sidecar down"; expect_no_msg "cookie expired"; expect_clean_message

# Sidecar down: no answer at all; and any other unexpected session status.
run sidecar_down STUB_SESSION=000
expect_rc 0; expect_sends 1; expect_msg_is "Reelsmith watchdog: sidecar down (session check HTTP 000)"; expect_clean_message
run session_500 STUB_SESSION=500
expect_rc 0; expect_sends 1; expect_msg_is "Reelsmith watchdog: sidecar session check failed (HTTP 500)"
run session_404 STUB_SESSION=404
expect_rc 0; expect_sends 1; expect_msg "sidecar session check failed (HTTP 404)"; expect_no_msg "sidecar down"

# TikTok unreachable from a healthy sidecar (502) is not the watchdog's: the desk covers it.
run session_502 STUB_SESSION=502
expect_rc 0; expect_sends 0; expect_out "ok: no alert"

# Everything the old watchdog reported is silent now, with every other sidecar answer bad.
run old_conditions_silent STUB_PSQL_OUT='9|1234|0' STUB_STATS=500 STUB_STATS_BODY='{"hours_since_success":99,"paused_until":"2026-10-18T09:00:00+02:00"}'
expect_rc 0; expect_sends 0; expect_out "ok: no alert"; expect_count sidecar.count 1

# TEST_ALERT=1: exactly one test message, no checks, exit 0 (even with the sidecar down).
run test_alert TEST_ALERT=1 STUB_SESSION=000
expect_rc 0; expect_sends 1; expect_msg_is "Reelsmith watchdog: test alert, Telegram delivery works"
expect_count sidecar.count 0; expect_clean_message
run test_alert_send_fails TEST_ALERT=1 STUB_TG=500
expect_rc 1; expect_out "telegram send failed (HTTP 500)"

# Validation: hostile or missing config never reaches a request or the message.
run hostile_chat TG_CHAT='42&text=evil'
expect_rc 1; expect_sends 0; expect_out "TG_CHAT is missing or not a numeric chat id"; case $OUT in *evil*) fail "chat id echoed" ;; *) pass ;; esac
run token_newline TG_TOKEN="$(printf '123:abc\nevil')"
expect_rc 1; expect_sends 0; expect_out "TG_TOKEN is missing or malformed"
run hostile_account ACCOUNT='x&y=1'
expect_rc 1; expect_sends 0; expect_count sidecar.count 0; expect_out "ACCOUNT is missing or malformed"
run hostile_sidecar_url SIDECAR_URL='http://evil.example.com:80/x?'
expect_rc 1; expect_sends 0; expect_count sidecar.count 0; expect_out "SIDECAR_URL is missing or malformed"

# A failed send exits 1 and prints only the HTTP status (the stub's stderr carries the URL).
run send_fails_400 STUB_SESSION=401 STUB_TG=400
expect_rc 1; expect_out "FATAL: telegram send failed (HTTP 400)"
run send_fails_unreachable STUB_SESSION=401 STUB_TG=000
expect_rc 1; expect_out "FATAL: telegram send failed (HTTP 000)"

echo "watchdog selftest ($WATCHDOG_SH): $((checks - fails))/$checks checks passed"
[ "$fails" -eq 0 ]
