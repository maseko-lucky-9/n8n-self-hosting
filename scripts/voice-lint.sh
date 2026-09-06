#!/usr/bin/env bash
# Voice lint for client-facing copy in this repository.
#
#   scripts/voice-lint.sh docs/n8n-estate-report.md
#
# Exit 0 = clean. Exit 1 = a hard-constraint violation.
#
# SOURCE OF TRUTH is the website repository's docs/pages/_voice-guide.md and
# ADR-015. This script is a copy of those rules, not the rules themselves: when the
# voice guide changes, this file is stale until someone updates it. It lives here
# because client-facing copy lives here, and a gate that runs once by hand is not a
# gate.
#
# It extracts the client-facing section by heading range from the real file. An
# earlier version pointed at a filename that was never created, so it passed while
# reading nothing. Do not reintroduce a fixed path.
set -uo pipefail
F=${1:?file}
B=$(awk '/^# Section B/,0' "$F")
[ -n "$B" ] || { echo "FATAL: Section B not found in $F"; exit 2; }
echo "Section B extracted: $(printf '%s' "$B" | wc -l | tr -d ' ') lines"
T1='leverag|synerg|revolutionar|disrupt|world-class|best-in-class|seamless|cutting-edge|next-generation|transformative|\brobust\b|\bpowerful\b|supercharge|skyrocket|harness the power|unleash|game-chang|thought leadership|low-hanging fruit|in todays? fast-paced|passionate about|AI-powered|incredible|amazing|extraordinary|remarkable|phenomenal'
T2='\bn8n\b|postgres|google sheets|cloudflare|kubernetes|argocd|\bhelm\b|\bvault\b|\bredis\b|\bnotion\b|\bgmail\b|\bsmtp\b|\btitan\b|godaddy|\bntfy\b|webhook|\bhmac\b|\bworker\b|spreadsheet'
T3='\bR ?[0-9]|lt-25k|25-75k|75-150k|150k-plus|per month|day rate of'
T4='capitec|absa|e4 strategic'
T5='calendly|whatsapp|book a (call|consultation)|tel:|phone us|call us on'
fail=0
for pair in "banned phrases/hyperbole:$T1" "tool names:$T2" "pricing:$T3" "employer:$T4" "second conversion path:$T5"; do
  label=${pair%%:*}; pat=${pair#*:}
  n=$(printf '%s' "$B" | grep -oiE "$pat" | wc -l | tr -d ' ')
  if [ "$n" = "0" ]; then echo "ok    $label = 0"; else
    echo "FAIL  $label = $n"; printf '%s' "$B" | grep -niE "$pat" | head -5 | sed 's/^/        /'; fail=1; fi
done
# Review tier: out-of-scope service names are allowed ONLY in the exclusions sentence.
echo "--- review tier (allowed only as exclusions) ---"
printf '%s' "$B" | grep -niE 'software develop|devops|ci/cd|api build|cloud migration|website (design|launch)|hosting' | sed 's/^/        /'
exit $fail
