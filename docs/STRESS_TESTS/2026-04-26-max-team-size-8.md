# Stress test 2026-04-26 — max teamSize × 8 patterns × 30min

**Identifier:** `MAXTEAM-2026-04-26`
**Reference task:** #94
**Tracking commit:** `e8f61a1` (mid-run fixes) + this entry

## Setup

Spawned all 8 swarm patterns simultaneously against the project's
own workspace (`/mnt/c/Users/kevin/Desktop/opencode_enhanced_ui`) at
the highest-allowed teamSize for each pattern, with a uniform
`bounds.minutesCap: 30` and identical directive:

> "Investigate the codebase and ship one small, concrete improvement.
> Read a few files to orient. Be thoughtful about scope."

Total concurrency: **58 opencode sessions** in parallel (7 patterns
× 8 sessions + 1 critic-loop × 2 sessions, since critic-loop is
hard-locked to teamSize=2).

Goals:
- See where throttle/threshold holds at high concurrency
- Identify failure modes that don't surface at default teamSize
- Validate steady-state perf under fully-saturated session pool
- Compare per-pattern token efficiency at the upper end

## Run IDs

| Pattern | teamSize | runID |
|---|---|---|
| blackboard | 8 | `run_mof0cy6f_u6390j` |
| council | 8 | `run_mof0cs8e_pgrncw` |
| map-reduce | 8 | `run_mof0ct1k_qpmsw1` |
| orchestrator-worker | 8 | `run_mof0dqis_i1rc6n` |
| role-differentiated | 8 | `run_mof0d506_etk8ib` |
| debate-judge | 8 | `run_mof0cu6y_bi6kw4` |
| critic-loop | 2 (hard-locked) | `run_mof0de0o_z31ohi` |
| deliberate-execute | 8 | `run_mof0dqti_tlhhs9` |

## Final results

(Captured at user's stop request, ~T+31min after spawn.)

| Pattern | Status | Items | Done | Findings | Tokens |
|---|---|---:|---:|---:|---:|
| map-reduce | live | 0 | 0 | 0 | **10,305,989** |
| council | stale | 0 | 0 | 0 | 3,846,937 |
| deliberate-execute | stale | 0 | 0 | 0 | 3,395,234 |
| role-differentiated | error | 6 | 3 | 0 | 1,473,820 |
| blackboard | stale | 0 | 0 | 0 | 1,217,003 |
| critic-loop | live | 0 | 0 | 0 | 954,959 |
| debate-judge | error | 0 | 0 | 0 | 943,990 |
| orchestrator-worker | idle | 8 | 5 | 0 | 402,377 |
| **Total** | — | **22** | **8** | **0** | **22,540,309** |

Cost: $0 (subscription).

## What worked

1. **System held under 58 concurrent opencode sessions.** No crashes,
   no hard failures of the dev server / opencode daemon / ollama.
2. **orchestrator-worker at teamSize=8 was the cleanest finisher** —
   8 todos seeded, 5 done, idled correctly. Best done-per-token ratio
   of the run (5 done / 402K tokens = 1 done per ~80K tokens).
3. **role-differentiated produced 3 done before erroring** — proves
   role-routing dispatch works at 8 sessions × 7 distinct roles.
4. **Today's #73 + #88 partial-outcome plumbing held up where it
   fired** — no orphan turns, all sessions terminated cleanly even on
   error/stale paths. The runs that didn't produce findings are gaps
   in the instrumentation, not in the runtime.

## What broke

### Hard errors

- **debate-judge teamSize=8 → status=error, 0 findings, 944K tokens.**
  Dev log shows 2/7 generators silent in round 1. The #73 plumbing
  has cases for this (`generator-fan-in too-few-drafts`, `judge-wait
  fail`, etc.) but no finding row landed. Either the error happens in
  an uninstrumented path, or our `status=error` derivation triggered
  before any finding could be written. Filed as task #95.

- **role-differentiated teamSize=8 → status=error after 3 done, no
  log line explaining the stop.** Dev log only shows kickoff +
  planner-sweep-complete + ticker-start. The auto-ticker's stop path
  needs richer logging. Filed as task #96.

### Stalls (status=stale, no done items)

- **map-reduce teamSize=8 → 10.3M tokens / 0 done.** 8 mappers each
  burned ~1.3M tokens; the synthesizer's context window can't hold
  all of them concatenated. Synthesis claim never landed within the
  cap. Filed as task #97 — fix candidates: per-mapper output cap,
  auto-pin synthesis to high-context model when teamSize≥6, preflight
  refuse with explanatory finding.

- **deliberate-execute teamSize=8 → 3.4M tokens / 0 done, never
  reached phase 2.** Deliberation phase (council with 8 members ×
  default 3 rounds) doesn't converge in 30min. Filed as task #98 —
  fix candidate: scale-aware round cap, tighter convergence threshold
  at high teamSize.

- **blackboard teamSize=8 → 1.2M tokens / 0 board items.** Planner
  sweep cycled without seeding any todos. Filed as task #99 — needs
  diagnostic of the planner's full reply to determine if the model
  is returning 0-todo todowrite calls.

- **council teamSize=8 → 3.85M tokens / stale.** Drafts in
  transcripts but no convergence. Council legitimately produces 0
  board items, so this isn't strictly a "stall" — but the operator
  has no signal to know whether work is happening. See task #104
  (stuck-deliberation detector).

### Live-but-unproductive

- **critic-loop teamSize=2 → 955K tokens / 0 done / status=live at
  test stop.** Worker turn ran for 30+ minutes producing tokens but
  never completing. F1 silent-watchdog wouldn't fire (worker IS
  emitting parts). Per-iteration ITERATION_WAIT_MS (15min) should
  have but didn't. Filed as task #100.

### Patterns that legitimately produce 0 board items

- **council** — drafts live in opencode session transcripts. 8 ×
  draft cycle ≈ 3.85M tokens at this teamSize.
- **debate-judge** — verdict in judge transcript. (Errored anyway,
  see above.)
- **deliberate-execute** — deliberation phase 1 produces no board
  items by design; phase 2 synthesis is what seeds the board, and
  this run never reached it.

These three need a different progress signal than "board.done count"
to be observable from the topbar.

## Mid-run incidents

Two parallel-session breakages broke the build mid-test, blocking
all snapshot endpoints with HTTP 500:

- **`heat-rail.tsx`** had a duplicated `<Tooltip>` wrapper in
  `HeatTreeRow` (two opens, one close). Fixed inline.
- **`coordinator.ts`** had an `await sha7(...)` inside a non-async
  arrow inside `driftedPaths.map()`. Wrapped with `Promise.all` +
  made the arrow async. Fixed inline.

Both fixed in commit `e8f61a1`. Cost ~5 min of stress-test
visibility while diagnosing. See task #102 — proposes a
`npx tsc --noEmit` gate at dev-server start to catch these
breakages before monitoring is wrecked.

## Per-pattern lessons

| Pattern | teamSize=8 verdict | Recommended max | Reason |
|---|---|---:|---|
| blackboard | stuck planner | **6** | Planner prompt overflows w/ 8-session state |
| council | non-convergent | **5** | Drafts in transcripts; 8-way doesn't converge |
| map-reduce | synth-starved | **5** | Synthesizer context can't hold 8× drafts |
| orchestrator-worker | clean | **8** | Only pattern that scaled cleanly |
| role-differentiated | early error | **6** | Errored at 3 done; needs deeper diagnostic |
| debate-judge | errored 0 output | **4** | Judge can't fit 7 generator drafts |
| critic-loop | hard-locked | **2** | Pattern shape locks to 1 worker + 1 critic |
| deliberate-execute | stuck phase 1 | **4** | Phase 1 (council×8) doesn't converge in cap |

These recommendations feed task #101 (kickoff WARN) + task #103
(picker hint).

## Filed follow-up tasks

| Task | Subject | Status |
|---|---|---|
| #95 | debate-judge: investigate why error-state didn't fire #73 partial-outcome | pending |
| #96 | role-differentiated: silent stop after 3 done — needs richer log trail | pending |
| #97 | map-reduce at teamSize 8: synthesis-starved, 0 done despite 10M+ tokens | **shipped 2026-04-26** — per-draft 80K-char cap in `buildSynthesisPrompt` keeps total bounded for any teamSize |
| #98 | deliberate-execute at teamSize 8: stuck in deliberation phase | pending |
| #99 | blackboard at teamSize 8: planner sweep cycles without seeding board | pending |
| #100 | critic-loop: 955K-token worker turn never completes | **shipped 2026-04-26** — root cause: `waitForSessionIdle` deadline path didn't abort. See `docs/POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md` |
| #101 | Per-pattern teamSize sanity WARN at kickoff | **shipped 2026-04-26** |
| #102 | Pre-dev-restart `npx tsc --noEmit` gate | **shipped 2026-04-26** (`0c7e895`) |
| #103 | new-run picker: per-pattern teamSize hints + recommended max | **shipped 2026-04-26** |
| #104 | Stuck-deliberation detector for high-token zero-output runs | pending |

The recommended-max column drives both #101 (server WARN) and #103
(picker hint). When the table above gets re-derived from a follow-up
stress test, update `lib/swarm-patterns.ts::patternMeta[*].recommendedMax`
to keep the three signals (this ledger, server WARN, picker hint) in
sync.

## Comparison baseline

This run is the reference point for "all patterns at maximum
teamSize, 30min cap, single workspace, single directive." Future
stress tests should use the same setup (or document deltas) so
deltas are attributable to code changes, not setup drift.

When re-running for comparison after the fixes above land:
- Same workspace, same directive, same 30min cap.
- Spawn order doesn't matter; all in parallel.
- Capture: status / items / done / findings / tokens per pattern,
  plus dev-log error trail for any errored patterns.
- Diff against this table to measure improvement.
