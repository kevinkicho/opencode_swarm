#!/usr/bin/env bash
# smart-smoke-test.sh
#
# Intelligent swarm pattern smoke test with dynamic monitoring.
# See header comment for full docs.

LOG_DIR="${2:-$(date +%Y%m%d_%H%M%S)_smoke}"
SWARM_API="http://localhost:8044"
WORKSPACE='C:\Users\kevin\Desktop\ktopologymath040226'
SOURCE='https://github.com/kevinkicho/ktopologymath040226'

DRY_RUN=0
SKIP_COMPLETED=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)         DRY_RUN=1 ;;
    --skip-completed)  SKIP_COMPLETED=1 ;;
  esac
done

PATTERNS=(
  "none|1|3|List the top-level directory structure and describe what this repo does in a brief summary"
  "blackboard|3|20|Review the README and identify the 3 most important improvements needed and implement them as concrete code changes"
  "map-reduce|3|15|Survey the codebase and produce a synthesis of what each major module does and how they connect"
  "council|3|15|Propose and compare approaches for improving the test coverage in this repo, then implement the best one"
  "orchestrator-worker|3|20|Find and fix the top 3 bugs or code quality issues in this codebase"
  "debate-judge|3|10|Debate whether the current architecture is well-suited for extension, then implement the winning argument's recommendation"
  "critic-loop|2|15|Iteratively improve the README documentation until a critic would approve it as production-quality"
)

SUMMARY="${LOG_DIR}/summary.csv"
mkdir -p "$LOG_DIR"
echo "preset,pattern,teamSize,runID,outcome,durationSec,tokensTotal,costTotal,notes" > "$SUMMARY"

ts() { date '+%H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

log "════════════════════════════════════════════════════════════════"
log "  SMART SMOKE TEST — $(date)"
log "  Workspace: ${WORKSPACE}"
log "  Swarm API: ${SWARM_API}"
log "  Log dir:   ${LOG_DIR}"
log "════════════════════════════════════════════════════════════════"

HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${SWARM_API}/api/swarm/providers" --max-time 10 2>/dev/null)
if [[ "$HEALTH" != "200" ]]; then
  log "  ✗ swarm API unreachable (HTTP ${HEALTH})"
  exit 1
fi
log "✓ swarm API reachable (HTTP ${HEALTH})"

TOTAL=${#PATTERNS[@]}
PASSED=0
FAILED=0
SEQ=0

for ENTRY in "${PATTERNS[@]}"; do
  IFS='|' read -r PATTERN TEAM_SIZE TIMEOUT_MIN DIRECTIVE <<< "$ENTRY"
  SEQ=$((SEQ + 1))
  TIMEOUT_SEC=$((TIMEOUT_MIN * 60))

  log ""
  log "════════════════════════════════════════════════════════════════"
  log "  Run ${SEQ}/${TOTAL}: ${PATTERN} (teamSize=${TEAM_SIZE}, timeout=${TIMEOUT_MIN}m)"
  log "  Directive: ${DIRECTIVE:0:80}..."
  log "════════════════════════════════════════════════════════════════"

  if [[ $DRY_RUN -eq 1 ]]; then
    log "  [DRY RUN] Would create pattern=${PATTERN}, teamSize=${TEAM_SIZE}"
    echo "run${SEQ},${PATTERN},${TEAM_SIZE},,dry-run,skipped,0,0,0,dry" >> "$SUMMARY"
    continue
  fi

  START_EPOCH=$(date +%s)

  BODY=$(python3 -c "
import json,sys
print(json.dumps({
  'pattern': '${PATTERN}',
  'workspace': r'${WORKSPACE}',
  'source': '${SOURCE}',
  'directive': '''${DIRECTIVE}''',
  'teamSize': ${TEAM_SIZE},
  'bounds': {'costCap': 0.50}
}))
")

  log "  Creating run..."
  RESPONSE=$(curl -s --max-time 30 -X POST \
    -H 'Content-Type: application/json' \
    -d "$BODY" \
    "${SWARM_API}/api/swarm/run" 2>&1) || RESPONSE='{}'

  RUN_ID=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('swarmRunID',''))" 2>/dev/null) || RUN_ID=""

  if [[ -z "$RUN_ID" ]]; then
    log "  ✗ ERROR: Failed to create run. Response: $(echo "$RESPONSE" | head -c 200)"
    echo "run${SEQ},${PATTERN},${TEAM_SIZE},,error,0,0,0,create_failed" >> "$SUMMARY"
    FAILED=$((FAILED + 1))
    continue
  fi

  log "  ✓ Run created: ${RUN_ID}"
  echo "$RESPONSE" > "${LOG_DIR}/create_${PATTERN}.json"

  ELAPSED=0
  PREV_TOKENS=0
  STALL_NUDGE_COUNT=0
  CONSECUTIVE_STALL_POLLS=0
  POLL_SEC=8

  while true; do
    sleep "$POLL_SEC"
    ELAPSED=$((ELAPSED + POLL_SEC))

    ALL_RUNS=$(curl -s --max-time 15 "${SWARM_API}/api/swarm/run" 2>&1) || ALL_RUNS='{"runs":[]}'
    echo "$ALL_RUNS" > "${LOG_DIR}/status_${PATTERN}_${ELAPSED}s.json"

    PARSED=$(echo "$ALL_RUNS" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('rows',d.get('runs',[]))
row=[r for r in rows if r.get('meta',{}).get('swarmRunID','')=='${RUN_ID}']
if row:
  r=row[0]
  status=r.get('status','unknown')
  tokens=r.get('tokensTotal',0) or 0
  cost=r.get('costTotal',0) or 0
  n=len(r.get('meta',{}).get('sessionIDs',[]))
  print(f'{status}|{tokens}|{cost}|{n}')
else:
  print('unknown|0|0|0')
" 2>/dev/null) || PARSED="unknown|0|0|0"

    IFS='|' read -r STATUS TOKENS COST ALIVE <<< "$PARSED"

    log "  [${ELAPSED}s] status=${STATUS} tokens=${TOKENS}"

    if [[ "$STATUS" == "completed" ]]; then
      DUR=$((ELAPSED))
      log "  ✓ COMPLETED: ${PATTERN} finished in ${DUR}s (${TOKENS} tokens, \$${COST})"
      echo "run${SEQ},${PATTERN},${TEAM_SIZE},${RUN_ID},completed,${DUR},${TOKENS},${COST},ok" >> "$SUMMARY"
      PASSED=$((PASSED + 1))
      break
    fi

    if [[ "$STATUS" == "stale" || "$STATUS" == "idle" ]]; then
      if [[ "$TOKENS" -gt 1000 ]]; then
        DUR=$((ELAPSED))
        log "  ✓ STALE (productive): ${PATTERN} produced ${TOKENS} tokens in ${DUR}s"
        echo "run${SEQ},${PATTERN},${TEAM_SIZE},${RUN_ID},stale,${DUR},${TOKENS},${COST},productive" >> "$SUMMARY"
        PASSED=$((PASSED + 1))
        break
      fi
      CONSECUTIVE_STALL_POLLS=$((CONSECUTIVE_STALL_POLLS + 1))
      if [[ $CONSECUTIVE_STALL_POLLS -ge 3 ]]; then
        log "  ⚠ Stale with < 1000 tokens for 3+ polls. Stopping."
        curl -s -X POST "${SWARM_API}/api/swarm/run/${RUN_ID}/stop" --max-time 10 2>/dev/null || true
        DUR=$((ELAPSED))
        echo "run${SEQ},${PATTERN},${TEAM_SIZE},${RUN_ID},stale,${DUR},${TOKENS},${COST},low_tokens" >> "$SUMMARY"
        FAILED=$((FAILED + 1))
        break
      fi
    fi

    if [[ "$STATUS" == "live" || "$STATUS" == "idle" ]]; then
      CONSECUTIVE_STALL_POLLS=0
      if [[ "$TOKENS" -gt "$PREV_TOKENS" ]]; then
        PREV_TOKENS=$TOKENS
        STALL_NUDGE_COUNT=0
      else
        STALL_NUDGE_COUNT=$((STALL_NUDGE_COUNT + 1))
        if [[ $STALL_NUDGE_COUNT -eq 10 ]]; then
          log "  ⚠ No token growth for $((STALL_NUDGE_COUNT * POLL_SEC))s. Sending nudge..."
          curl -s -X POST "${SWARM_API}/api/swarm/run/${RUN_ID}/nudge" \
            -H 'Content-Type: application/json' \
            -d '{"reason":"smoke-test-stall"}' --max-time 10 2>/dev/null || true
        fi
        if [[ $STALL_NUDGE_COUNT -ge 20 ]]; then
          log "  ⚠ No progress after nudge. Stopping run."
          curl -s -X POST "${SWARM_API}/api/swarm/run/${RUN_ID}/stop" --max-time 10 2>/dev/null || true
          DUR=$((ELAPSED))
          echo "run${SEQ},${PATTERN},${TEAM_SIZE},${RUN_ID},timeout,${DUR},${TOKENS},${COST},stalled" >> "$SUMMARY"
          FAILED=$((FAILED + 1))
          break
        fi
      fi
    fi

    if [[ "$STATUS" == "error" ]]; then
      DUR=$((ELAPSED))
      log "  ✗ ERROR state detected for ${PATTERN}"
      echo "run${SEQ},${PATTERN},${TEAM_SIZE},${RUN_ID},error,${DUR},${TOKENS},${COST},error_state" >> "$SUMMARY"
      FAILED=$((FAILED + 1))
      break
    fi

    if [[ $ELAPSED -ge $TIMEOUT_SEC ]]; then
      log "  ⏱ Timeout (${TIMEOUT_MIN}m). Stopping."
      curl -s -X POST "${SWARM_API}/api/swarm/run/${RUN_ID}/stop" --max-time 10 2>/dev/null || true
      DUR=$((ELAPSED))
      echo "run${SEQ},${PATTERN},${TEAM_SIZE},${RUN_ID},timeout,${DUR},${TOKENS},${COST},wallclock" >> "$SUMMARY"
      FAILED=$((FAILED + 1))
      break
    fi
  done

  COOLDOWN=10
  log "  Cooldown ${COOLDOWN}s..."
  sleep "$COOLDOWN"
done

log ""
log "════════════════════════════════════════════════════════════════"
log "  SMOKE TEST COMPLETE"
log "  ${PASSED} passed, ${FAILED} failed, ${TOTAL} total"
log "  Results → ${SUMMARY}"
log "  Logs → ${LOG_DIR}/"
log "════════════════════════════════════════════════════════════════"
log ""
log "preset  pattern              teamSize  runID  outcome  durationSec  tokensTotal  costTotal  notes"
while IFS=, read -r preset pattern teamSize runID outcome dur tokens cost notes; do
  [[ "$preset" == "preset" ]] && continue
  printf " %-6s %-20s %-9s %-6s %-8s %-12s %-12s %-10s %s\n" \
    "$preset" "$pattern" "$teamSize" "$runID" "$outcome" "$dur" "$tokens" "$cost" "$notes"
done < "$SUMMARY"