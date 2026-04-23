#!/usr/bin/env bash
# Sequential battle driver: fires council, blackboard, map-reduce against
# a clean kyahoofinance032926 clone, captures SSE + final board + diff.
set -u
BASE="http://localhost:49187/api/swarm"
WORKSPACE="C:/Users/kevin/Workspace/kyahoofinance032926"
TARGET="/mnt/c/Users/kevin/Workspace/kyahoofinance032926"
SRC="https://github.com/kevinkicho/kyahoofinance032926"
DIRECTIVE='Review this codebase. Identify and implement up to 3 improvements you consider high-impact. Make the edits directly on disk. Reply with a brief summary of what you changed and why.'
LOG_BASE="/mnt/c/Users/kevin/Desktop/opencode_enhanced_ui/demo-log/battle-2026-04-22-b"
WINDOW_SEC=600
SETTLE_SEC=60

mkdir -p "$LOG_BASE"
printf 'driver start %s\n' "$(date -Iseconds)" > "$LOG_BASE/driver.log"
printf '%s\n' "$DIRECTIVE" > "$LOG_BASE/DIRECTIVE.txt"

run_pattern() {
  local pattern="$1" slot="$2"
  local OUT="$LOG_BASE/$slot"
  mkdir -p "$OUT"
  date -Iseconds > "$OUT/start-ts.txt"
  (cd "$TARGET" && git rev-parse HEAD) > "$OUT/start-commit.txt"

  local body
  body=$(jq -cn --arg p "$pattern" --arg w "$WORKSPACE" --arg s "$SRC" --arg d "$DIRECTIVE" \
    '{pattern:$p, workspace:$w, source:$s, directive:$d}')
  printf '[%s] POST run for %s\n' "$(date -Iseconds)" "$pattern" >> "$LOG_BASE/driver.log"

  local resp
  resp=$(curl -s -X POST "$BASE/run" -H 'Content-Type: application/json' -d "$body")
  printf '%s' "$resp" > "$OUT/launch.json"

  local run_id
  run_id=$(printf '%s' "$resp" | jq -r '.swarmRunID // empty')
  if [ -z "$run_id" ]; then
    printf '[%s] FAIL no swarmRunID for %s\n' "$(date -Iseconds)" "$pattern" >> "$LOG_BASE/driver.log"
    return 1
  fi
  printf '%s' "$run_id" > "$OUT/run-id.txt"
  printf '[%s] %s run_id=%s\n' "$(date -Iseconds)" "$pattern" "$run_id" >> "$LOG_BASE/driver.log"

  curl -s --max-time "$WINDOW_SEC" -N "$BASE/run/$run_id/events" > "$OUT/events.ndjson" 2>"$OUT/events.err" &
  local evpid=$!
  local bdpid=""
  if [ "$pattern" = "blackboard" ]; then
    curl -s --max-time "$WINDOW_SEC" -N "$BASE/run/$run_id/board/events" > "$OUT/board-events.ndjson" 2>"$OUT/board-events.err" &
    bdpid=$!
  fi

  sleep "$WINDOW_SEC"

  kill "$evpid" 2>/dev/null || true
  [ -n "$bdpid" ] && { kill "$bdpid" 2>/dev/null || true; }
  wait 2>/dev/null

  if [ "$pattern" = "blackboard" ]; then
    curl -s "$BASE/run/$run_id/board" > "$OUT/final-board.json"
  fi
  curl -s "$BASE/run/$run_id" > "$OUT/run-meta.json"

  printf '[%s] %s settling for %ss\n' "$(date -Iseconds)" "$pattern" "$SETTLE_SEC" >> "$LOG_BASE/driver.log"
  sleep "$SETTLE_SEC"

  (cd "$TARGET" && \
    git add -A > /dev/null 2>&1 && \
    git diff --cached > "$OUT/agent.diff" && \
    git diff --cached --stat > "$OUT/agent.diff.stat" && \
    git reset > /dev/null 2>&1) || true

  date -Iseconds > "$OUT/end-ts.txt"
  printf '[%s] %s done\n' "$(date -Iseconds)" "$pattern" >> "$LOG_BASE/driver.log"
}

reset_target() {
  (cd "$TARGET" && \
    git reset --hard HEAD > /dev/null 2>&1 && \
    git clean -fd > /dev/null 2>&1) || true
  printf '[%s] target reset\n' "$(date -Iseconds)" >> "$LOG_BASE/driver.log"
}

run_pattern council pattern-1-council
reset_target

run_pattern blackboard pattern-2-blackboard
reset_target

run_pattern map-reduce pattern-3-mapreduce
reset_target

printf '[%s] ALL DONE\n' "$(date -Iseconds)" >> "$LOG_BASE/driver.log"
