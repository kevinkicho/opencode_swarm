#!/usr/bin/env bash
# Generates a summary report across all runs launched by the multi-
# pattern test script. Reads the test script's log file, extracts
# every `run_id=` emitted, queries each run's final meta + token state
# + board summary + commit count, writes a markdown report.
#
# Usage:
#   bash scripts/_multi_pattern_report.sh <log-file> [output.md]
#
# Example:
#   bash scripts/_multi_pattern_report.sh \
#     /tmp/claude-1000/.../tasks/bwf4wpbj1.output \
#     /tmp/multi-pattern-report.md

set -uo pipefail

LOG=${1:-}
OUT=${2:-/tmp/multi-pattern-report.md}
DEV='http://127.0.0.1:49187'
WS='C%3A%5CUsers%5Ckevin%5CWorkspace%5Ckyahoofinance032926'

if [[ -z "$LOG" || ! -f "$LOG" ]]; then
  echo "Usage: $0 <log-file> [output.md]" >&2
  echo "Log file required. Found multi-pattern runs here:" >&2
  ls -lt /tmp/claude-1000/*/tasks/ 2>/dev/null | grep -v '^total' | head -10 >&2
  exit 1
fi

RUN_IDS=$(grep 'RUN KICKOFF' "$LOG" | sed -E 's/.*run_id=([^ ]+).*/\1/' | sort -u)
if [[ -z "$RUN_IDS" ]]; then
  echo "No RUN KICKOFF lines in $LOG — nothing to report" >&2
  exit 1
fi

{
  echo '# Multi-pattern ollama test run — summary'
  echo
  echo "_Generated $(date '+%Y-%m-%d %H:%M:%S') from $LOG_"
  echo
  echo '## Runs'
  echo
  echo '| pattern | runID | sessions | items | done | stale | criteria | tokens | cost | status | started |'
  echo '|---------|-------|----------|-------|------|-------|----------|--------|------|--------|---------|'

  for RID in $RUN_IDS; do
    META=$(curl -s --max-time 15 "$DEV/api/swarm/run/$RID" 2>/dev/null)
    BOARD=$(curl -s --max-time 15 "$DEV/api/swarm/run/$RID/board" 2>/dev/null)
    TOKENS=$(curl -s --max-time 15 "$DEV/api/swarm/run/$RID/tokens" 2>/dev/null)
    pattern=$(echo "$META"  | jq -r '.pattern // "?"')
    sessions=$(echo "$META" | jq -r '.sessionIDs | length')
    started=$(echo "$META" | jq -r '.createdAt | (. / 1000 | strftime("%H:%M:%S"))' 2>/dev/null || echo '?')
    total=$(echo "$BOARD" | jq -r '.items // [] | length')
    done=$(echo "$BOARD"  | jq -r '[.items // [] | .[] | select(.kind=="todo" and .status=="done")] | length')
    stale=$(echo "$BOARD" | jq -r '[.items // [] | .[] | select(.status=="stale")] | length')
    crit=$(echo "$BOARD"  | jq -r '[.items // [] | .[] | select(.kind=="criterion")] | length')
    toks=$(echo "$TOKENS" | jq -r '.totals.tokens // 0')
    cost=$(echo "$TOKENS" | jq -r '.totals.cost // 0')
    status=$(echo "$TOKENS" | jq -r '.totals.status // "?"')
    printf '| %s | `%s` | %s | %s | %s | %s | %s | %s | $%s | %s | %s |\n' \
      "$pattern" "$RID" "$sessions" "$total" "$done" "$stale" "$crit" "$toks" "$cost" "$status" "$started"
  done

  echo
  echo '## Provider distribution per run'
  echo
  echo '_Confirms runs used ollama and not opencode-go. Looks at first assistant message of each session._'
  echo
  for RID in $RUN_IDS; do
    META=$(curl -s --max-time 15 "$DEV/api/swarm/run/$RID" 2>/dev/null)
    pattern=$(echo "$META"  | jq -r '.pattern // "?"')
    echo
    echo "### \`$pattern\` — \`$RID\`"
    echo '| session role | provider/model | assistant msgs |'
    echo '|--------------|----------------|----------------|'
    SIDS=$(echo "$META" | jq -r '.sessionIDs[]')
    idx=0
    for sid in $SIDS; do
      msgs=$(curl -s --max-time 10 "$DEV/api/opencode/session/$sid/message?directory=$WS" 2>/dev/null)
      count=$(echo "$msgs" | jq '[.[] | select(.info.role == "assistant")] | length')
      first=$(echo "$msgs" | jq -r '[.[] | select(.info.role == "assistant")][0] | if . == null then "-" else "\(.info.providerID)/\(.info.modelID)" end' 2>/dev/null)
      printf '| session[%s] | %s | %s |\n' "$idx" "$first" "$count"
      idx=$((idx+1))
    done
    for label in critic auditor verifier; do
      sid=$(echo "$META" | jq -r ".${label}SessionID // empty")
      [[ -z "$sid" ]] && continue
      msgs=$(curl -s --max-time 10 "$DEV/api/opencode/session/$sid/message?directory=$WS" 2>/dev/null)
      count=$(echo "$msgs" | jq '[.[] | select(.info.role == "assistant")] | length')
      first=$(echo "$msgs" | jq -r '[.[] | select(.info.role == "assistant")][0] | if . == null then "-" else "\(.info.providerID)/\(.info.modelID)" end' 2>/dev/null)
      printf '| %s | %s | %s |\n' "$label" "$first" "$count"
    done
  done

  echo
  echo '## Workspace git state'
  echo
  cd /mnt/c/Users/kevin/Workspace/kyahoofinance032926 2>/dev/null && {
    echo '### Commits since multi-pattern run started'
    git log --oneline --since='4 hours ago' | head -30
    echo
    echo '### Uncommitted diff stat'
    git diff --stat | tail -5
  }
} > "$OUT"

echo "Report written: $OUT"
wc -l "$OUT"
