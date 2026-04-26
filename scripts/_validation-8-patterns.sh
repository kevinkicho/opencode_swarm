#!/usr/bin/env bash
# Serial validation: 8 swarm patterns × 1h each against
# /mnt/c/Users/kevin/Workspace/kyahoofinance032926.
#
# Order: blackboard → orchestrator-worker → map-reduce → council →
#        role-differentiated → debate-judge → critic-loop → deliberate-execute.
#
# Per pattern: POST /api/swarm/run → capture swarmRunID → sleep 60min →
# POST /api/swarm/run/:id/stop → log row → next.
#
# Total wallclock: ~8h. Output is one structured line per phase to stdout
# (also tee'd to .validation-8.log). Each line is greppable for the
# Monitor: SPAWN, RUNNING, STOPPED, ERROR.

set -uo pipefail

DEV_PORT="$(cat .dev-port 2>/dev/null || echo 52440)"
DEV_BASE="http://127.0.0.1:${DEV_PORT}"
WORKSPACE='C:\Users\kevin\Workspace\kyahoofinance032926'
SOURCE='https://github.com/kevinkicho/kyahoofinance032926'
DIRECTIVE='Audit the README claims about implemented features (market dashboards, sidebar KPI strips, Currency Picker, exports, global search). Identify the highest-impact gaps between claims and the current implementation. Implement the gaps you find as concrete code changes.'
RUN_MINUTES=60
LEDGER=.validation-8.log
# Pre-spawn ollama probe target. We hit /api/chat with num_predict=1 on
# the workhorse model — burns 1 token but gives an accurate 429 signal
# for ollama-cloud's rate-limit. Other errors (5xx, network) treated as
# transient and don't block — the actual run will fail fast if ollama
# is fully dead, which is more informative than a probe loop.
OLLAMA_BASE='http://172.24.32.1:11434'
PROBE_MODEL='gemma4:31b-cloud'
PROBE_INTERVAL=300  # seconds between rate-limit re-checks

# Each line: pattern|teamSize|extra-flags-json
PATTERNS=(
  "blackboard|3|{}"
  "orchestrator-worker|3|{}"
  "map-reduce|3|{}"
  "council|3|{}"
  "role-differentiated|3|{}"
  "debate-judge|3|{}"
  "critic-loop|2|{}"
  "deliberate-execute|3|{}"
)

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { local line="$(ts) $*"; echo "$line"; echo "$line" >> "$LEDGER"; }

# Probe ollama with a 1-token completion. Returns:
#   0 — ready (HTTP 200, or non-429 transient that we don't block on)
#   1 — rate-limited (HTTP 429)
ollama_ready() {
  local body code
  body='{"model":"'"$PROBE_MODEL"'","messages":[{"role":"user","content":"ok"}],"stream":false,"options":{"num_predict":1}}'
  code=$(curl -s -o /tmp/ollama-probe.body -w "%{http_code}" --max-time 45 \
    -X POST "$OLLAMA_BASE/api/chat" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>/dev/null)
  if [[ "$code" == "429" ]]; then return 1; fi
  return 0
}

# Block until ollama returns non-429. Logs each attempt.
wait_for_ollama_clear() {
  local attempts=0
  while ! ollama_ready; do
    attempts=$((attempts + 1))
    log "[$idx/8] PAUSED ollama rate-limited (attempt $attempts) · sleeping ${PROBE_INTERVAL}s"
    sleep "$PROBE_INTERVAL"
  done
  if [[ $attempts -gt 0 ]]; then
    log "[$idx/8] RESUMED ollama clear after $attempts pause(s)"
  fi
}

# Patterns whose auto-ticker is the dispatcher; we stop/start it on
# 429 so workers don't keep silent-freezing during the rate-limit
# window. Other patterns (council, debate-judge, critic-loop,
# map-reduce, none) have no ticker — pause-extend still fires for
# them but the kickoff coroutine just rides out the limit.
has_ticker() {
  case "$1" in
    blackboard|orchestrator-worker|role-differentiated|deliberate-execute) return 0 ;;
    *) return 1 ;;
  esac
}

ticker_action() {
  local runID=$1 action=$2
  curl -s --max-time 30 -o /dev/null -w "%{http_code}" \
    -X POST -H 'Content-Type: application/json' \
    -d "{\"action\":\"$action\"}" \
    "$DEV_BASE/api/swarm/run/$runID/board/ticker" 2>/dev/null
}

# Probe the ticker for a ticker-backed pattern. Returns:
#   0 — ticker active (or no ticker exists, or probe failed transiently)
#   1 — ticker stopped (state: "stopped" in JSON)
# On unrecognised JSON shapes, returns 0 (don't short-circuit on noise).
ticker_stopped() {
  local runID=$1
  local body
  body=$(curl -s --max-time 10 "$DEV_BASE/api/swarm/run/$runID/board/ticker" 2>/dev/null)
  [[ -z "$body" ]] && return 0
  local stopped
  stopped=$(jq -r '.stopped // false' <<<"$body" 2>/dev/null)
  [[ "$stopped" == "true" ]]
}

# Active-time sleep: waits for a wallclock budget of `active_seconds`
# of NON-rate-limited time. Probes every PROBE_INTERVAL; on 429,
# stops the ticker (if applicable), keeps probing on the same cadence,
# and on the first 200 restarts the ticker. Pause time doesn't count
# against the budget — the run gets a full active window regardless of
# how often ollama goes dark.
#
# #7.Q36 — additionally probes the ticker; if the ticker stops early
# (commits-cap, opencode-frozen, etc.) we break out of active_sleep
# immediately instead of waiting out the full window. Limited to
# ticker-backed patterns; non-ticker patterns ride the wallclock.
active_sleep() {
  local runID=$1 pattern=$2 active_seconds=$3
  local active_remaining=$active_seconds
  local pattern_has_ticker=0
  if has_ticker "$pattern"; then pattern_has_ticker=1; fi

  while [[ $active_remaining -gt 0 ]]; do
    local step=$PROBE_INTERVAL
    [[ $step -gt $active_remaining ]] && step=$active_remaining
    sleep "$step"
    active_remaining=$((active_remaining - step))

    # #7.Q36 early-stop: if this is a ticker pattern and the ticker has
    # stopped, advance to the next pattern. Saves up to 50+ min of
    # dead wallclock when a run hits commits-cap / opencode-frozen / etc.
    if [[ $pattern_has_ticker -eq 1 ]] && ticker_stopped "$runID"; then
      log "[$idx/8] EARLY-STOP $pattern · run=$runID · ticker stopped · skipping ${active_remaining}s of remaining wallclock"
      return 0
    fi

    if ! ollama_ready; then
      local pause_attempts=0 pause_started ticker_action_resp
      pause_started=$(date +%s)
      if [[ $pattern_has_ticker -eq 1 ]]; then
        ticker_action_resp=$(ticker_action "$runID" stop)
        log "[$idx/8] PAUSED-MIDRUN $pattern · run=$runID · 429 detected · ticker stop=$ticker_action_resp · active_remaining=${active_remaining}s"
      else
        log "[$idx/8] PAUSED-MIDRUN $pattern · run=$runID · 429 detected · no ticker (kickoff rides) · active_remaining=${active_remaining}s"
      fi
      while ! ollama_ready; do
        pause_attempts=$((pause_attempts + 1))
        sleep "$PROBE_INTERVAL"
      done
      local pause_dur=$(( $(date +%s) - pause_started ))
      if [[ $pattern_has_ticker -eq 1 ]]; then
        ticker_action_resp=$(ticker_action "$runID" start)
        log "[$idx/8] RESUMED-MIDRUN $pattern · run=$runID · ticker start=$ticker_action_resp · paused=${pause_dur}s · attempts=$pause_attempts"
      else
        log "[$idx/8] RESUMED-MIDRUN $pattern · run=$runID · paused=${pause_dur}s · attempts=$pause_attempts"
      fi
    fi
  done
}

log "VALIDATION-8 start · dev=$DEV_BASE · workspace=$WORKSPACE · probe=$OLLAMA_BASE/$PROBE_MODEL"

idx=0
for entry in "${PATTERNS[@]}"; do
  idx=$((idx + 1))
  IFS='|' read -r pattern teamSize extra <<<"$entry"

  # Pre-spawn rate-limit gate. If ollama is currently 429, sit on it
  # until clear. Avoids spawning runs into a quota wall — the run would
  # still kick off but every assistant turn would silent-freeze, burn
  # the 60-min wallclock, and surface as opencode-frozen.
  wait_for_ollama_clear

  # Build request body. jq composes safely so newlines/quotes in the
  # directive don't break the JSON.
  body=$(jq -nc \
    --arg pattern "$pattern" \
    --arg workspace "$WORKSPACE" \
    --arg source "$SOURCE" \
    --arg directive "$DIRECTIVE" \
    --argjson teamSize "$teamSize" \
    --argjson minutesCap "$RUN_MINUTES" \
    --argjson extra "$extra" \
    '{
      pattern: $pattern,
      workspace: $workspace,
      source: $source,
      directive: $directive,
      title: ($pattern + " · validation-8 · " + ($minutesCap | tostring) + "m"),
      teamSize: $teamSize,
      bounds: { minutesCap: $minutesCap, todosCap: 50, commitsCap: 30 }
    } * $extra')

  log "[$idx/8] SPAWN $pattern · teamSize=$teamSize · cap=${RUN_MINUTES}m"
  resp=$(curl -s --max-time 120 -X POST -H 'Content-Type: application/json' \
    -d "$body" "$DEV_BASE/api/swarm/run")
  runID=$(jq -r '.swarmRunID // empty' <<<"$resp" 2>/dev/null)
  if [[ -z "$runID" ]]; then
    err=$(jq -r '.error // .message // "unknown"' <<<"$resp" 2>/dev/null)
    log "[$idx/8] ERROR $pattern · spawn failed: $err · raw=$(printf %q "$resp" | head -c 240)"
    continue
  fi
  url="http://172.24.37.95:${DEV_PORT}/?swarmRun=${runID}"
  log "[$idx/8] RUNNING $pattern · run=$runID · url=$url"

  # Active-time sleep: gives the run a full RUN_MINUTES of non-rate-
  # limited wallclock. Pauses the ticker on 429 (ticker patterns) so
  # workers don't silent-freeze burning the budget; non-ticker patterns
  # still benefit from the deadline-extend so partial work isn't cut
  # short by quota-eaten time. 30s tail-buffer to let the auto-ticker
  # land its own stop before we POST /stop.
  active_sleep "$runID" "$pattern" $((RUN_MINUTES * 60))
  sleep 30

  log "[$idx/8] STOPPING $pattern · run=$runID"
  stop=$(curl -s --max-time 60 -X POST "$DEV_BASE/api/swarm/run/$runID/stop")
  log "[$idx/8] STOPPED  $pattern · run=$runID · resp=$(printf '%s' "$stop" | head -c 200)"

  # Brief breather so opencode tears down sessions before the next spawn.
  sleep 30
done

log "VALIDATION-8 complete · all 8 patterns processed"
