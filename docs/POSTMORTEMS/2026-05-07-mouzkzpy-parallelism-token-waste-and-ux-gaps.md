# 2026-05-07 · Run mouzkzpy — Post-mortem: parallelism, token waste, and UX gaps

**Run:** `run_mouzkzpy_bx2cv2`
**Pattern + models:** blackboard · glm-5.1:cloud (planner) + gemma4:31b-cloud × 2 (workers) + nematron-3-super:cloud (worker)
**Outcome:** Force-stopped by operator after 105 min. 21/35 todos completed, 1 in-progress, 13 open, 21 criteria open. 0 stale. Run consumed 14.6M tokens ($0.29).

## What happened

The run progressed through 5 planner sweeps over 105 minutes, completing 21 todos. Key timeline:

- **Sweep 1** (initial): 8 criteria + 18 todos → all 18 eventually completed
- **Sweep 2**: 5 criteria + 7 todos (including 3 re-proposals of already-done work)
- **Sweep 3**: 4 criteria + 7 todos (more re-proposals)
- **Sweep 4**: 4 criteria + 3 todos
- **Sweep 5**: 2 findings (operator-hard-stop + planner-sweep error)

7 "turn went silent" retries across workers — all eventually completed on retry.

The run was force-stopped by the operator after observing: agents appearing "idle" when actually queued, error badges persisting on retried-and-completed todos, a phantom "compaction" agent, and sluggish progress.

## Token waste

### 1. Per-run dispatch mutex serializes all workers

**Root cause:** `withDispatchMutex` in `coordinator/dispatch.ts` chains ALL session ticks for a run into a single promise chain. When `fanout()` fires 3 per-session ticks "in parallel," each `tickCoordinator` call acquires the same run-level mutex, so Session B waits for Session A's entire claim→prompt→LLM-response→commit cycle (5-15 min on ollama cloud).

**Impact:** 105 min for 21 todos ≈ 5 min/todo. With true parallelism, the batch of 21 could have been ~20 min (longest single turn). ~80 min was idle time between serial dispatches.

**Estimated waste:** ~60% of run time was workers waiting their turn.

### 2. Planner token overhead — 5 sweeps reading the same workspace

Each planner sweep reads 5-10 workspace files (~6.5M input tokens total for the planner session across 5 sweeps). The planner re-reads many of the same files on each sweep. With `includeBoardContext: true`, the prompt also grows as more items are added.

**Estimated waste:** 2-3× redundant file reads across sweeps. The planner consumed 84% of total tokens (6.5M of 7.6M per the previous run's analysis; similar ratio here).

### 3. Re-proposals — planner re-proposed already-completed work

Sweeps 2-4 re-proposed the same themes: "wire /amend", "round-robin ambition", "ollamaFormat JSON schema", "user-role entries", "stigmergy directive" — all of which were already done or in-progress. The planner's `includeBoardContext: true` should prevent this, but the board had 8-21 done items by sweep 2, and the planner still proposed similar work.

**Impact:** 3-6 wasted slots per re-sweep (duplicate todos that the coordinator marks as "open" but workers can't meaningfully claim because the work is already done).

### 4. Session [3] (nematron) did zero work

The 4th worker session (nematron-3-super:cloud) was never assigned a single todo. The per-run mutex + planner occupying the mutex for 15-22 min per sweep meant only 3 workers ever got dispatched. The 4th session sat idle the entire run, consuming no tokens but also producing no output.

**Impact:** 25% of team capacity wasted. The coordinator's picker uses `for...of` over session candidates and picks the first idle one; with the mutex, the first 3 sessions always win.

### 5. "Turn went silent" retries — 7 occurrences

Each silent turn wastes a full LLM call's tokens. With gemma4:31b-cloud's latency, each retry costs ~2-3 min of wall time + corresponding tokens. All 7 eventually succeeded, so the waste is the retry overhead, not permanent loss.

### 6. Compaction agent creates phantom roster row

Opencode's built-in context compaction fires on the planner session (glm-5.1:cloud), creating "assistant" messages with `agent: 'compaction'`. The UI's `toAgents()` treats these as a separate agent row, making it appear as though 5 agents are active when only 4 sessions exist. The compaction agent has the planner's model and no clear parent relationship shown in the UI.

## What we did (queued as todos)

- **F1. Per-session dispatch mutex** — Replace the per-run mutex with a per-session mutex so workers can operate in parallel. CAS on board items already protects against two sessions claiming the same todo.
- **F2. Soft-abort for blackboard** — Abort chip currently only kills one session. For blackboard-family patterns, it must stop the ticker + abort all sessions.
- **F3. Force-stop arm-phase freeze** — First click of force-stop should immediately pause the ticker so no new dispatches start while waiting for confirmation.
- **F4. Page refresh bug** — Status changes must update in-place via SSE, not trigger full page reload.
- **F5. Status indicators** — Merge ticker `inFlight` state into `toAgents()` so queued workers show as "-working" not "idle."
- **F6. Bottombar active count** — Should reflect true parallelism, not blink 1↔0.
- **F7. Latest button** — Sticky-scroll in chat view.
- **F8. Agent tooltips** — Show status detail on hover.
- **F9. Agent names** — Use role-aware names (architect, implementer) instead of plan/build#N.
- **F10. Compaction agent** — Merge compaction parts into their parent session's agent row.
- **F11. Stale error badges** — Don't show permanent error counts for todos that succeeded on retry.
- **F12. Roster tab ordering** — Default-on, left of plan tab.
- **F13. Roster sparkline** — Always-on with growing time x-axis, remove underline token bar.

## How we'd know it regressed

- F1: A blackboard run with 4 workers where only 3 get assigned work.
- F2: Abort button on blackboard run leaves sessions running.
- F3: Force-stop arm phase shows agents still going "thinking" between clicks.
- F4: Full page reload after any status change.
- F5: All workers show "idle" when queued behind the mutex.

## Ledger

| Finding | Status | Verification |
|---|---|---|
| F1. Per-session dispatch mutex | SHIPPED | `lib/server/blackboard/coordinator/dispatch.ts` — mutex key includes sessionID when opts.restrictToSessionID is set |
| F2. Soft-abort for blackboard | SHIPPED | `components/swarm-topbar/abort-chips.tsx` — ticker-backed patterns call /stop?reason=abort instead of single-session abort |
| F3. Force-stop arm-phase freeze | NOT-APPLICABLE | 3-second arm window is too brief to justify server-side ticker pause; inFlight status fix (F5) resolves the underlying flicker |
| F4. Page refresh via SSE | NOT-APPLICABLE | Full reloads are only triggered by dev-mode build-staleness detection (`use-dev-build-id.ts`), not a production bug |
| F5. Status indicators merge inFlight | SHIPPED | `app/page-internals/use-page-data.ts` — agents with in-flight ticks show as "thinking" instead of "idle" |
| F6. Bottombar active count | SHIPPED | Same fix as F5 — multiple workers with in-flight ticks now count as active simultaneously |
| F7. Latest button | SHIPPED | `components/chat-view.tsx` — ScrollToBottomButton mounted on scroll container |
| F8. Agent tooltips | NOT-APPLICABLE | Already present on agent roster rows (status dot tooltip shows status + focus + tokens) |
| F9. Agent role names | SHIPPED | `app/page-internals/use-page-data.ts` — roleNamesBySessionID overrides opencode agent names (planner, worker-2) |
| F10. Compaction agent merged | SHIPPED | `lib/opencode/transform/to-agents.ts` — messages with agent==='compaction' filtered out |
| F11. Stale error badges | SHIPPED | `lib/agent-status.ts` — computeAttention filters errors/retries predating the last successful message |
| F12. Roster tab default-on | SHIPPED | `components/left-tabs.tsx` — roster tab now left of plan, default active |
| F13. Roster sparkline always-on | SHIPPED | `components/agent-roster/agent-row.tsx` — sparkline always rendered, budget bar removed |
| Planner dedup guard | SHIPPED | `lib/server/blackboard/planner/sweep.ts` — tokenOverlap dedup drops proposals ≥0.6 similar to existing board items |
| StopReason operator-abort | SHIPPED | `lib/server/blackboard/auto-ticker/types.ts` + `/stop` route + `lib/blackboard/live.ts` — distinct from operator-hard-stop |
| TickerSlotSnapshot | SHIPPED | `lib/server/blackboard/auto-ticker/types.ts` — per-session inFlight exposed to client via TickerSnapshot.slots |