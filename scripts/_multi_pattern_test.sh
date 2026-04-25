#!/usr/bin/env bash
# Multi-pattern test runner (2026-04-24). Sequentially fires every
# blackboard-family + adjacent swarm pattern against the kyahoofinance
# workspace, 25 min each (5 min for 'none'), then reports aggregated
# stats. Pattern model defaults (shipped in commit d6f8728) pin the
# ollama-tier models per role automatically — no teamModels override
# needed in the POST bodies.
#
# Stdout events are Monitor-friendly: `[RUN START]`, `[RUN KICKOFF]`,
# `[CHECKPOINT]`, `[RUN END]`, `[RUN FAIL]`. A monitoring agent can
# tail this script's output and wake on any of these tags.
#
# Launch via `bash scripts/_multi_pattern_test.sh > /tmp/multi-run.log 2>&1 &`
# or through the Bash tool's run_in_background.

set -uo pipefail

DEV='http://127.0.0.1:49187'
# Backslashes escaped — the script interpolates this verbatim into a
# JSON heredoc, and raw `\U` / `\W` are invalid JSON string escapes.
WS='C:\\Users\\kevin\\Workspace\\kyahoofinance032926'
SOURCE='https://github.com/kevinkicho/kyahoofinance032926'
DIRECTIVE='Keep building the yahoo-finance macro-dashboard. Treat the README and KNOWN_LIMITATIONS.md as the backlog — close real gaps, wire unshipped claims, ship substantive features. No busywork.'
# 30s pause between patterns (was 120s, dropped 2026-04-24 — user
# observed only 3 of 9 patterns got real time during the prior test
# because the pause + per-pattern duration ate too much wall-clock).
PAUSE_BETWEEN=30
# After a pattern's minutesCap fires, give the coordinator up to this
# long to wind down naturally before we move on. Replaces the prior
# explicit `{action:stop}` POST to the ticker — that was an abrupt
# kill that aborted live planner turns mid-flight. Letting the run's
# own caps + auto-idle handle termination produces cleaner end-state
# data + avoids the "planner_aborted_at_15:26" pattern from the
# 2026-04-24 audit.
GRACEFUL_DRAIN_MAX_S=120

log() {
  printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

# Sanity-probe the dev server before wasting time on orchestration.
probe_dev() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$DEV/api/swarm/run")
  if [[ "$code" != "200" ]]; then
    log "[FATAL] dev server at $DEV not responding (HTTP $code) — aborting"
    return 1
  fi
  log "[OK] dev server responsive at $DEV"
}

# Fire one pattern, poll its state every 5 min for the duration, stop
# ticker at the end, pause, return. Args:
#   $1 pattern name
#   $2 teamSize
#   $3 duration minutes
#   $4 (optional) extra JSON fragment to merge into the POST body —
#      must start with a comma, e.g. `, "enableAuditorGate": true`
run_pattern() {
  local pattern=$1
  local team=$2
  local mins=$3
  local extra=${4:-''}

  log "[RUN START] pattern=$pattern team=$team target=${mins}m"

  local body
  body=$(cat <<EOF
{
  "pattern": "$pattern",
  "workspace": "$WS",
  "source": "$SOURCE",
  "directive": "$DIRECTIVE",
  "teamSize": $team,
  "bounds": { "minutesCap": $mins, "commitsCap": 200, "todosCap": 300 }
  $extra
}
EOF
)

  local resp
  resp=$(curl -s --max-time 60 -X POST "$DEV/api/swarm/run" \
    -H 'Content-Type: application/json' \
    -d "$body")

  local run_id
  run_id=$(printf '%s' "$resp" | jq -r '.swarmRunID // empty' 2>/dev/null)

  if [[ -z "$run_id" ]]; then
    log "[RUN FAIL] pattern=$pattern — no swarmRunID in response"
    log "  response: $(printf '%s' "$resp" | head -c 400)"
    return 1
  fi

  local session_count
  session_count=$(printf '%s' "$resp" | jq -r '.sessionIDs | length')
  log "[RUN KICKOFF] pattern=$pattern run_id=$run_id sessions=$session_count"

  local deadline=$(( $(date +%s) + mins * 60 ))
  local poll_interval=300  # 5 min
  # Short patterns (none = 5 min) should emit at least one checkpoint
  # before the deadline arrives.
  if (( mins <= 5 )); then poll_interval=120; fi

  while (( $(date +%s) < deadline )); do
    local remaining=$(( deadline - $(date +%s) ))
    if (( remaining < poll_interval )); then
      sleep "$remaining"
      break
    fi
    sleep "$poll_interval"

    local items tokens cost status
    items=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/board" 2>/dev/null \
      | jq -r '.items // [] | [length, (map(select(.status=="done")) | length), (map(select(.status=="stale")) | length), (map(select(.kind=="criterion")) | length)] | @tsv')
    tokens=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/tokens" 2>/dev/null \
      | jq -r '.totals.tokens // 0')
    cost=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/tokens" 2>/dev/null \
      | jq -r '.totals.cost // 0')
    status=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/board/ticker" 2>/dev/null \
      | jq -r '.state // "unknown"')

    # items_tsv: totalItems \t done \t stale \t criteria
    local total_items=$(printf '%s' "$items" | cut -f1)
    local done_ct=$(printf '%s' "$items" | cut -f2)
    local stale_ct=$(printf '%s' "$items" | cut -f3)
    local crit_ct=$(printf '%s' "$items" | cut -f4)
    local elapsed=$(( (mins * 60 - (deadline - $(date +%s))) / 60 ))

    log "[CHECKPOINT] pattern=$pattern run=$run_id elapsed=${elapsed}m items=$total_items done=$done_ct stale=$stale_ct crit=$crit_ct tokens=$tokens cost=\$$cost ticker=$status"
  done

  # No explicit ticker stop — let the run end on its own (minutesCap +
  # commitsCap + auto-idle handle this). Wait up to GRACEFUL_DRAIN_MAX_S
  # for status to flip away from 'live' so the next pattern doesn't
  # start while this one is still mid-tier-escalation. If the run
  # genuinely won't quit (rare — usually means the planner is in a
  # tight loop), we cap the wait and move on; the run keeps going in
  # the background and any subsequent activity is fair game.
  local drain_deadline=$(( $(date +%s) + GRACEFUL_DRAIN_MAX_S ))
  while (( $(date +%s) < drain_deadline )); do
    local cur_status
    cur_status=$(curl -s --max-time 5 "$DEV/api/swarm/run" 2>/dev/null \
      | jq -r --arg id "$run_id" '.runs // [] | map(select(.meta.swarmRunID == $id)) | .[0].status // "unknown"')
    if [[ "$cur_status" != "live" ]]; then
      log "  drained naturally — status=$cur_status"
      break
    fi
    sleep 10
  done

  # Final snapshot.
  local final_items final_tokens final_cost
  final_items=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/board" 2>/dev/null \
    | jq -r '.items // [] | [length, (map(select(.status=="done")) | length), (map(select(.status=="stale")) | length)] | @tsv')
  final_tokens=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/tokens" 2>/dev/null \
    | jq -r '.totals.tokens // 0')
  final_cost=$(curl -s --max-time 10 "$DEV/api/swarm/run/$run_id/tokens" 2>/dev/null \
    | jq -r '.totals.cost // 0')

  local f_total=$(printf '%s' "$final_items" | cut -f1)
  local f_done=$(printf '%s' "$final_items" | cut -f2)
  local f_stale=$(printf '%s' "$final_items" | cut -f3)

  log "[RUN END] pattern=$pattern run=$run_id elapsed=${mins}m items=$f_total done=$f_done stale=$f_stale tokens=$final_tokens cost=\$$final_cost"

  if (( PAUSE_BETWEEN > 0 )); then
    log "[PAUSE] ${PAUSE_BETWEEN}s before next pattern"
    sleep "$PAUSE_BETWEEN"
  fi
}

log '=== Multi-pattern test run START ==='
log "target=kyahoofinance032926"
log "9 patterns sequential, ~3h25m total"

probe_dev || { log '[FATAL] dev server probe failed — aborting'; exit 1; }

# Pattern order: blackboard-family (ticker, validated) → non-ticker
# shapes (council/map-reduce/critic/debate/deliberate). 'none' is
# excluded per user direction 2026-04-24 — we're testing the swarm
# patterns specifically, not the single-session degenerate.

run_pattern 'blackboard' 5 25 ', "enableAuditorGate": true, "enableCriticGate": true, "persistentSweepMinutes": 20'

run_pattern 'orchestrator-worker' 5 25 ', "enableAuditorGate": true, "persistentSweepMinutes": 20'

run_pattern 'role-differentiated' 5 25 ', "enableAuditorGate": true, "persistentSweepMinutes": 20'

run_pattern 'map-reduce' 4 25

run_pattern 'council' 3 25

run_pattern 'critic-loop' 2 25

run_pattern 'debate-judge' 4 25

run_pattern 'deliberate-execute' 3 25

log '=== ALL PATTERNS COMPLETE ==='
