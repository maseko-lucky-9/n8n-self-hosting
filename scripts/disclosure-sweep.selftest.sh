#!/usr/bin/env bash
# Self-test for scripts/disclosure-sweep.sh:
#   - the Telegram bot token and TikTok `sessionid` patterns fire, and stay specific;
#   - an npm lockfile `"integrity": "sha512-..."` line is excluded, but nothing else on that
#     line or elsewhere in a lockfile is (the whole file is never skipped);
#   - the real Reelsmith project files, docs/decisions and its CI workflow stay clean.
#
#   bash scripts/disclosure-sweep.selftest.sh [path/to/disclosure-sweep.sh]
#
# Fixtures are assembled at run time from short pieces, so this file itself never matches a
# deny pattern. Exits non-zero on any failed check.
set -euo pipefail

cd "$(dirname "$0")/.."
SWEEP=${1:-scripts/disclosure-sweep.sh}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0
checks=0

OUT=
RC=0
sweep() { RC=0; OUT=$(bash "$SWEEP" "$@" 2>&1) || RC=$?; }
check() { checks=$((checks + 1)); if [ "$2" = ok ]; then return 0; fi; fails=$((fails + 1)); echo "FAIL [$1] $3: $OUT"; }
# expect_hit NAME MATCH FILE: the sweep fails AND reports MATCH as a hit's text (file:line:MATCH),
# so a hit from some other, older rule does not count.
expect_hit() {
  sweep "$3"
  case $RC:$OUT in 1:*":$2"*) check "$1" ok ;; *) check "$1" bad "want a hit with text '$2' (exit $RC)" ;; esac
}
# expect_no_hit NAME MATCH FILE: no hit with that text (other rules may still fire).
expect_no_hit() {
  sweep "$3"
  case $OUT in *":$2"*) check "$1" bad "unexpected hit '$2'" ;; *) check "$1" ok ;; esac
}
# expect_clean NAME FILE...: the sweep passes.
expect_clean() {
  local name=$1
  shift
  sweep "$@"
  if [ "$RC" = 0 ]; then check "$name" ok; else check "$name" bad "want clean (exit $RC)"; fi
}
fixture() { local f="$work/$1"; mkdir -p "$(dirname "$f")"; printf '%s\n' "$2" > "$f"; printf '%s' "$f"; }

# Telegram bot token: 8-10 digit bot id, a colon, 35 characters.
tok_tail=$(printf 'AAHk3x9_Z-%.0s' 1 2 3 4)          # 40 characters
token="123456789:${tok_tail:0:35}"
expect_hit token_yaml "$token" "$(fixture token.yaml "bot_token: \"$token\"")"
expect_hit token_url "$token" "$(fixture token.txt "https://api.telegram.org/bot$token/sendMessage")"
expect_clean token_short_tail "$(fixture token-short.txt "123456789:${tok_tail:0:34}")"
expect_clean token_short_id "$(fixture token-id.txt "1234567:${tok_tail:0:35}")"

# TikTok session cookie value: 32 hex characters after `sessionid`, any case.
hex=0123456789abcdef
key=sessionid
expect_hit sessionid_eq "$key=$hex$hex" "$(fixture sid1.txt "$key=$hex$hex")"
expect_hit sessionid_json "$key\": \"$hex$hex" "$(fixture sid2.json "{\"$key\": \"$hex$hex\"}")"
expect_hit sessionid_upper "SESSIONID: $hex$hex" "$(fixture sid3.txt "SESSIONID: $hex$hex")"
expect_hit sessionid_quote "$key='$hex$hex" "$(fixture sid4.txt "$key='$hex$hex'")"
# 31 hex: the sessionid rule stays quiet (the older generic `id=` rule still fires).
expect_no_hit sessionid_31hex "$key=" "$(fixture sid5.txt "$key=$hex${hex:0:15}")"

# Lockfile: the integrity line alone is excluded; smuggling next to it is not.
piece=vtEhXh/gNjI9Yg1u
b64="$piece$piece$piece$piece$piece${piece:0:6}=="  # 86 base64 characters + padding
lock_dir=n8n-self-hosting/projects/reelsmith-social-publish/scripts  # the path the old whole-file skip matched
integrity="      \"integrity\": \"sha512-$b64\","
expect_clean lockfile_integrity "$(fixture "a/$lock_dir/package-lock.json" "{
  \"packages\": {
    \"node_modules/luxon\": {
$integrity
      \"license\": \"MIT\"
    }
  }
}")"
expect_hit lockfile_smuggled_line "$b64" "$(fixture "b/$lock_dir/package-lock.json" "{
$integrity
      \"note\": \"$b64\"
}")"
expect_hit lockfile_token_on_integrity_line "$token" "$(fixture lock2/package-lock.json "$integrity \"x\": \"$token\"")"
expect_hit lockfile_other_algorithm "$b64" "$(fixture lock3/package-lock.json "      \"integrity\": \"sha1-$b64\",")"

# The real files stay clean.
real=()
while IFS= read -r f; do [ -f "$f" ] && real+=("$f"); done < <(
  git ls-files projects/reelsmith-social-publish docs/decisions .github/workflows/reelsmith-selfcheck.yaml scripts/disclosure-sweep.selftest.sh
)
expect_clean real_lockfile projects/reelsmith-social-publish/scripts/package-lock.json
expect_clean real_reelsmith_files "${real[@]}"

echo "disclosure-sweep selftest: $((checks - fails))/$checks checks passed"
[ "$fails" -eq 0 ]
