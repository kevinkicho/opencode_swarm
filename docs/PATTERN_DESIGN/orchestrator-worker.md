# Pattern: orchestrator-worker

**Status:** shipped, unvalidated (run_mod5dy6n_utsb32 hit silent failure — see POSTMORTEMS/)
**Session topology:** session 0 = orchestrator (planner + strategy owner), sessions 1..N = workers
**Observability maturity:** low — no surface today shows orchestrator re-planning activity

## 1 · Mechanics

Hierarchical variant of blackboard. Session 0 does NOT work on todos; it
owns strategy and re-planning. Reuses blackboard store + coordinator +
auto-ticker entirely, with one routing difference: workers-only dispatch.

- **Kickoff:** `runOrchestratorWorkerKickoff`
  (`lib/server/orchestrator-worker.ts:77`). Posts the orchestrator intro
  to session 0 with `agent='orchestrator'`. The intro emphasizes
  mission ownership, worker-count visibility, and revise-strategy
  authority (`buildOrchestratorIntroPrompt`, file:34-70; estimated size
  ~1.1 KB for a 4-worker team).
- **Initial sweep:** `runPlannerSweep` fires against session 0. Current
  `DEFAULT_TIMEOUT_MS = 15 * 60_000`
  (`lib/server/blackboard/planner.ts:70`) — the 15-min window that
  the 2026-04-24 postmortem silently ran out on.
- **Ticker start:** `startAutoTicker(swarmRunID, { orchestratorSessionID })`
  (file:157). The orchestrator's sessionID is passed as
  `excludeSessionIDs` — coordinator's picker skips it. Workers-only
  dispatch.
- **Re-plan cadence:** when the board drains or a periodic sweep
  fires, planner posts a fresh sweep prompt to session 0 with
  current board state. Orchestrator revises the plan, emits new
  todowrites, workers pick them up.

## 2 · Signals already emitted

- `swarmRunMeta.sessionIDs[0]` — the orchestrator session ID
- Agent attribution `orchestrator` on session 0 (visible in roster)
- Every planner sweep the orchestrator runs produces a new
  `todowrite` payload the app can diff against the previous sweep
- Board-state context embedded in each re-plan prompt
- `TickerSnapshot.currentTier` — escalation signals
- Worker vs orchestrator distinction in coordinator logs

What's NOT surfaced today:
- The plan-delta per sweep (added todos / removed todos / rephrased
  todos) is computable but never rendered
- Re-plan boundaries in the timeline are indistinguishable from
  worker dispatches

## 3 · Observability surface

### Existing
- Shares `board-rail` with blackboard pattern. No pattern-specific
  surface.

### Proposed — `strategy` tab

**Scope:** `pattern === 'orchestrator-worker'`. Left-panel tab group,
between `board` and `heat`.

**Layout:** vertical timeline, newest first. Each row represents a
planner-sweep fire event. h-6 rows (slightly taller than board-rail
because plan-delta summaries need 2 lines).

| col | content | width |
|---|---|---|
| round | `#N` tabular-nums | 24px |
| time | relative age (`2m`, `14m`) | 32px |
| board | snapshot chip: `12/40 · 3ip · 2stale` | 100px |
| added | `+5` mint | 28px |
| removed | `-2` rust (when non-zero) | 28px |
| excerpt | first 80 chars of orchestrator's plan text | flex |

**Header chip:** `R<currentRound> · sessions <N> · last re-plan <age>`.

**Row expansion:** click opens an inspector drawer showing the full
orchestrator message for that sweep + full board-state snapshot at
that moment. The drawer has a split view: left pane plan text, right
pane diff-against-previous-sweep.

**Iris background stripe** on rows where re-planning actually
changed the plan (added+removed ≠ 0). Fog-muted rows where the
sweep confirmed the existing plan without changes.

**Empty state:** `awaiting first plan — orchestrator is thinking`
when `sweepCount === 0` and session 0 has a pending assistant turn.
`no re-plans yet — first sweep completed at <time>, no revisions
since` when `sweepCount === 1`.

## 4 · Mechanics gaps

### I1 · Hard cap on re-plan loops

No limit on how many times the orchestrator can re-plan. If workers
repeatedly stale out (file contention, complexity underestimation),
the orchestrator can loop indefinitely proposing-then-watching-fail.
Add `MAX_REPLANS = 5` per run. On breach, stop the ticker with
`stopReason = 'replan-loop-exhausted'` and surface "orchestrator is
stuck in a re-plan loop; human intervention needed" in the run-health
banner.

### I2 · Plan-delta logging

Compute and log the plan delta on every re-plan (`added`, `removed`,
`rephrased`). Write to a new table `plan_revisions(swarm_run_id,
round, added_items_json, removed_items_json, rephrased_items_json,
created_at)`. Backs the `strategy` tab directly; without this, the
UI has to re-derive deltas client-side on each render.

### I3 · Re-plan on-demand endpoint

Today re-plans only fire on idle or periodic cadence. Add
`POST /api/swarm/run/:id/replan` so a human operator can trigger a
fresh sweep when they spot the orchestrator drifting. Returns
immediately; sweep fires in the background. Useful after manual
board edits.

### I4 · Orchestrator silent-turn detection

Shared with postmortem F1. The orchestrator's planner sweep runs on
session 0; a 15-min hang (as on run_mod5dy6n_utsb32) produces zero
signal until timeout. Dispatch watchdog should apply here too — it
would have caught the silent failure at t+90s.

## 5 · Ledger

| ID | Kind | Status | Commit | Verified against | Notes |
|---|---|---|---|---|---|
| strategy-tab | tab | SHIPPED | (next commit) | — | vertical newest-first sweep timeline; per-sweep board snapshot chip + +N/-M/~K delta counts; iris stripe when changed; click-to-expand shows full added/removed/rephrased text |
| I1 | improvement | SHIPPED | (next commit) | — | MAX_ORCHESTRATOR_REPLANS=6 cap enforced at attemptTierEscalation + runPeriodicSweep entry via orchestratorReplanCapHit (counts plan_revisions rows). Stop reason 'replan-loop-exhausted' added to StopReason union; RunHealthChip surfaces it as red dot with intervention message |
| I2 | improvement | SHIPPED | (next commit) | — | plan_revisions SQLite table + computeDelta token-jaccard ≥ 0.6 fuzzy match + GET /api/swarm/run/:id/strategy; logged from runPlannerSweep so all sweep paths (initial, attemptReSweep, runPeriodicSweep) feed it |
| I3 | improvement | SHIPPED | (next commit) | — | POST /api/swarm/run/:id/replan returns 202 + fires runPlannerSweep with overwrite+includeBoardContext in the background; strategy rail header has a `↻ replan` button with idle/queueing/queued/failed states |
| I4 | improvement | SHIPPED | d824bf4 | run_modn6mrg_hxvssz | implemented as F1 dispatch watchdog inside `waitForSessionIdle`: WARN at SILENT_WARN_MS=90s of no-new-parts, abort at SILENT_ERROR_MS=240s with reason='silent'. Fires across all patterns including the orchestrator's planner sweep on session 0. Verified: 1 WARN + 2 aborts on real silent sessions during the live multi-pattern test (POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md). |

## 6 · Cross-references

- `SWARM_PATTERNS.md` §5 — orchestrator-worker stance
- `lib/server/orchestrator-worker.ts` — kickoff + intro builder
- `docs/POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md` — the
  silent-failure case that first exposed this pattern's observability
  gap
- `blackboard.md` — shared mechanics (this pattern is a blackboard
  variant)
