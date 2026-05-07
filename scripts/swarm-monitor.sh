#!/usr/bin/env bash
# swarm-monitor.sh
#
# Periodic status dashboard for all active swarm runs.
# Uses /api/swarm/run which has computed status/tokens.
# Also polls /api/swarm/run/:id/board/ticker for live runs to
# surface alerts: planner sweep errors (degraded-completion findings),
# premature auto-idle-drained stops, stale/blocked items, and tier
# escalation events.

SWARM_API="${1:-http://localhost:8044}"
POLL_SEC="${2:-15}"

ts() { date '+%H:%M:%S'; }

while true; do
  RUNS_JSON=$(curl -s --max-time 10 "${SWARM_API}/api/swarm/run" 2>/dev/null) || RUNS_JSON='{"runs":[]}'

  echo ""
  echo "[$(ts)] ═══ SWARM MONITOR ═══"

  ALERTS=""
  RUNS_PARSED=0

  # Parse and display runs
  DISPLAY=$(echo "$RUNS_JSON" | python3 -c "
import json,sys,time
d=json.load(sys.stdin)
rows=d.get('rows',d.get('runs',[]))
if not rows:
  print('  (no runs)')
  sys.exit(0)
for r in rows:
  m=r.get('meta',{})
  rid=m.get('swarmRunID','?')[:25]
  pat=m.get('pattern','?')
  status=r.get('status','?')
  tokens=r.get('tokensTotal',0) or 0
  cost=r.get('costTotal',0) or 0
  n_sessions=len(m.get('sessionIDs',[]))
  created=m.get('createdAt',0)
  age=''
  if created:
    age_s=int((time.time()*1000-created)/1000)
    if age_s<60: age=f'{age_s}s'
    elif age_s<3600: age=f'{age_s//60}m'
    else: age=f'{age_s//3600}h{age_s%3600//60}m'
  # Flag premature stops and error states
  flags=''
  stop_reason=r.get('stopReason','')
  if status in ('completed','idle') and stop_reason=='auto-idle-drained':
    commits=r.get('totalCommits',0) or 0
    if commits < 5:
      flags=' [!] LOW-COMMIT DRAINED'
  if status=='error':
    flags=' [!] ERROR'
  if flags:
    print(f'ALERT:{rid}:{flags.strip()}')
  print(f'  {rid:25s}  {pat:18s}  {status:10s}  tokens={tokens:>8d}  cost=\${cost:.4f}  sessions={n_sessions}  age={age}{flags}')
" 2>/dev/null) || echo "  (parse error)"

  echo "$DISPLAY"

  # For live/idle runs, check ticker and board for alerts
  echo "$RUNS_JSON" | python3 -c "
import json,sys,time
d=json.load(sys.stdin)
rows=d.get('rows',d.get('runs',[]))
for r in rows:
  m=r.get('meta',{})
  rid=m.get('swarmRunID','?')
  status=r.get('status','?')
  if status not in ('live','idle'):
    continue
  print(rid)
" 2>/dev/null | while read -r LIVE_RID; do
    # Check ticker for tier escalation and stop info
    TICKER_JSON=$(curl -s --max-time 5 "${SWARM_API}/api/swarm/run/${LIVE_RID}/board/ticker" 2>/dev/null) || continue
    echo "$TICKER_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
tier=d.get('currentTier','?')
idle=d.get('consecutiveIdle',0)
threshold=d.get('idleThreshold',0)
stopped=d.get('stopped',False)
reason=d.get('stopReason','')
commits=d.get('totalCommits',0)
if stopped:
  if reason=='auto-idle-drained' and commits < 5:
    print(f'  [!] ALERT: {\"\"} auto-idle-drained with only {commits} commits — tier escalation may not have produced work')
  if reason=='opencode-frozen':
    print(f'  [!] ALERT: {\"\"} stopped due to opencode-frozen — model provider may be unreachable')
  if reason=='zen-rate-limit':
    print(f'  [!] ALERT: {\"\"} stopped due to zen rate-limit — quota exhausted')
  if reason=='replan-loop-exhausted':
    print(f'  [!] ALERT: {\"\"} replan loop exhausted — planner keep failing to produce new work')
elif tier and tier != 1:
  print(f'  ↗ Tier escalated to T{tier} (idle={idle}/{threshold}, commits={commits})')
" 2>/dev/null
  done

  # For completed/stale runs, check board for degraded-completion findings
  echo "$RUNS_JSON" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rows=d.get('rows',d.get('runs',[]))
for r in rows:
  m=r.get('meta',{})
  rid=m.get('swarmRunID','?')[:25]
  status=r.get('status','?')
  stop_reason=r.get('stopReason','')
  commits=r.get('totalCommits',0) or 0
  tokens=r.get('tokensTotal',0) or 0
  # Surface runs that stopped with few commits relative to token spend
  if status in ('completed','stale') and tokens > 100000 and commits < 3:
    print(f'  [!] {rid} spent {tokens:,} tokens but only {commits} commits — likely planner errors')
" 2>/dev/null

  sleep "$POLL_SEC"
done