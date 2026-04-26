# Implementation Plan — Designed-but-Not-Shipped Backlog

Single-source-of-truth roadmap covering every proposal currently sitting
at `PROPOSED` status across the project. Audit done 2026-04-24 after
the user surfaced "we designed but didn't ship the per-pattern tabs" —
this doc takes inventory of all such work, sequences it sensibly, and
becomes the lookup for "what's next."

Update the **Status** column as items ship. Every shipped item also
needs to update its source doc (PATTERN_DESIGN ledger, POSTMORTEMS
ledger, STATUS.md). This file's status is the rollup.

---

## Phase 0 — Tactical fixes (blocker-clearing) · ~3 hours total

Quick wins that remove sharp edges users hit during live testing.
Safe, isolated, no architectural risk.

| # | Item | Source | Effort | Status |
|---|---|---|---|---|
| 0.1 | Lane meter `out — in —` placeholders show cumulative when rate=0 | STATUS.md | 30m | **SHIPPED** (c041edd) |
| 0.2 | `latest ↓` button two-phase synchronous snap (no smooth-scroll race) | STATUS.md | 15m | **SHIPPED** (c041edd) |
| 0.3 | Auto-ticker startup-cleanup skips runs with recent activity / open work | STATUS.md | 30m | **SHIPPED** (c041edd) |
| 0.4 | Retry-exhausted `[retry:N]` chip on board rows (F9 from postmortem) | POSTMORTEMS | 30m | **SHIPPED** (c041edd) |
| 0.5 | Reconcile `opencode.json` model context overrides (F6) | POSTMORTEMS | 15m | **VERIFIED** (2026-04-25) — config edit + restart confirmed runtime returns `context: 262144` for nemotron. |
| 0.6 | Add `--log-level DEBUG` to launcher (F3) — gates F5 below | POSTMORTEMS | 5m | **VERIFIED** (2026-04-25) — `OPENCODE_LOG` env var was wrong; actual flag is `--log-level DEBUG` per `opencode web --help`. `.ps1` updated, new log shows DEBUG entries flowing. F5 is now unblocked. |
| 0.7 | Dev wrapper orphan handling — make scripts/dev.mjs detach cleanly | STATUS.md | 1h | **SHIPPED** (next commit) — child spawned with `detached: true` (own process group); kill propagates via `process.kill(-pid, signal)` group-kill on SIGINT/SIGTERM/SIGHUP; `process.stdin` 'end' event triggers SIGTERM-then-SIGKILL group teardown when parent dies without forwarding a signal (orphan-via-reparenting case). Verified: killing the npm parent now cleanly tears down both the shell middleman AND the next-server grandchild. Port released; no stale processes. |

**Order rationale:** all are independent, ship as separate commits, ~30m each. Do these first to clear cruft before deeper UI work.

---

## Phase 1 — Per-pattern observability tabs (T1: pure UI, all data exists) · ~17 hours total

Pure view-layer work — no backend changes needed. Each tab spec is
already frozen in `docs/PATTERN_DESIGN/<pattern>.md` §3. Order by
visibility-to-user-when-running-that-pattern.

| # | Pattern | Tab | Source | Effort | Status |
|---|---|---|---|---|---|
| 1.1 | **blackboard** | `contracts` | PATTERN_DESIGN/blackboard.md §3 | 3h | **SHIPPED** (next commit) |
| 1.2 | **critic-loop** | `iterations` | PATTERN_DESIGN/critic-loop.md §3 | 3h | **SHIPPED** (next commit) |
| 1.3 | **debate-judge** | `debate` | PATTERN_DESIGN/debate-judge.md §3 | 3h | **SHIPPED** (next commit) |
| 1.4 | **role-differentiated** | `roles` | PATTERN_DESIGN/role-differentiated.md §3 | 3h | **SHIPPED** (next commit) |
| 1.5 | **map-reduce** | `map` | PATTERN_DESIGN/map-reduce.md §3 | 3h | **SHIPPED** (next commit) |
| 1.6 | **stigmergy** (overlay) | board-row heat decoration | PATTERN_DESIGN/stigmergy.md §3 | 2h | **SHIPPED** (next commit) |

**Implementation pattern (reusable across all 6):**
1. Read the pattern's §3 spec — column shape, sticky chips, sort order, palette.
2. Wire a new tab key into the `LeftTabs` component's tab list (or right-pane view switcher where appropriate).
3. Build the new component as `components/<pattern>-<tab-name>.tsx`.
4. Conditionally render only when `pattern === '<pattern>'`.
5. After mount, populate from the existing data hooks (`useLiveBoard`, `useLiveSwarmRunMessages`, etc.).
6. Test against an existing run with that pattern's data — fire a fresh test run if needed.
7. Wrap with `<ProfileBoundary id="<tab>">` so we can measure render cost.
8. Update the pattern's §5 ledger row → `SHIPPED` + commit hash.

**Aesthetic invariants (across all 6):**
- h-5/h-6 rows · monospace · tabular-nums
- text-micro (10px) uppercase tracking-widest2 for labels
- ink-* / fog-* / molten / mint / iris / amber palette only
- click row → opens existing inspector drawer (no new modal)

---

## Phase 2 — Per-pattern observability tabs (T2: minor data plumbing) · ~12 hours total

These need backend support before the UI lands. Plumbing is small but
must come first.

| # | Pattern | Tab | Backend prereq | UI | Status |
|---|---|---|---|---|---|
| 2.1 | **council** | `council` | client-side similarity compute (token-jaccard or cosine) | 4h | **SHIPPED** (next commit) |
| 2.2 | **deliberate-execute** | `phases` | phase-boundary detection in transform.ts | 4h | **SHIPPED** (next commit) |
| 2.3 | **orchestrator-worker** | `strategy` | `plan_revisions` SQLite table + per-sweep delta logging (I2) | 4h | **SHIPPED** (next commit) |

**Sequence:** 2.3 first (it has a clear backend prereq); 2.1 + 2.2 can go in either order.

---

## Phase 3 — Postmortem fixes (observability infrastructure) · ~10 hours total

Nine fixes (F1-F9) declared in the orchestrator-worker silent-failure
postmortem. Each has a validation probe documented in §3.

| # | Fix | What | Effort | Status | Notes |
|---|---|---|---|---|---|
| 3.1 | F1 | Dispatch watchdog — silent-turn detector in coordinator.ts | 2h | **SHIPPED** (next commit) | P0 — biggest single observability win |
| 3.2 | F2 | Tail opencode log into dev console | 2h | **SHIPPED** (next commit) | P0 |
| 3.3 | F4 | Ollama `/api/ps` liveness probe in waitForSessionIdle | 1h | **SHIPPED** (next commit) | P1 |
| 3.4 | F5 | Session-level error read (after F3 enables debug logging) | 1h | **WONTFIX** (2026-04-25) — F3 unblock investigation showed no session-level error field exists on `GET /session/:id` (only `{id, slug, projectID, directory, title, version, summary, time}`); all errors in DEBUG logs are either HTTP transport noise (`service=server error= failed`, empty content) or session.processor errors tied to a `messageID` (already surfaced via per-message `info.error`). Coverage is complete via that path + F1 watchdog + F2 log tail. See POSTMORTEMS F5 row for the evidence. | — |
| 3.5 | F7 | Preflight prompt-size estimate | 1h | **SHIPPED** (next commit) | P2 |
| 3.6 | F8 | Run-health banner in topbar | 2h | **SHIPPED** (next commit) | P3 — UI work |

**Validation:** each fix has a probe in `docs/POSTMORTEMS/2026-04-24-orchestrator-worker-silent.md` §3. Run probe against next live test run; promote ledger to VERIFIED if probe passes.

---

## Phase 4 — Pattern mechanics gaps (I1-I4 per pattern) · ~30+ hours total

Each pattern's design doc lists 4 mechanics improvements. These are
backend-logic changes (not UI). Cherry-picking the highest-leverage ones
first.

### Tier 1 (quick wins — 1-2h each)

| Pattern | Item | Effort |
|---|---|---|
| blackboard | I2 — retry-exhausted ratchet re-kick | 1h — **SHIPPED** |
| blackboard | I3 — persist ticker stopReason in SQLite | 2h — **SHIPPED** |
| blackboard | I4 — criterion authoring preflight | 1h — **SHIPPED** |
| orchestrator-worker | I1 — hard cap on re-plan loops | 1h — **SHIPPED** |
| council | I3 — minority-view preservation | 1h — **SHIPPED** |
| council | I4 — per-member round-timeout | 2h — **SHIPPED** |
| critic-loop | I4 — kickoff WARN if critic+worker share model | 30m — **SHIPPED** |
| debate-judge | I3 — generator-model-diversity kickoff WARN | 30m — **SHIPPED** |
| stigmergy | I1 — heat half-life decay | 2h — **SHIPPED** |

### Tier 2 (medium — 2-4h each)

| Pattern | Item | Effort |
|---|---|---|
| blackboard | I1 — auto-replan on CAS drift | 3h — **SHIPPED** |
| orchestrator-worker | I2 — plan-delta logging | 3h — **SHIPPED** with 2.3 |
| map-reduce | I1 — synthesis-critic gate | 4h |
| critic-loop | I1+I2 — structured verdict + auto-terminate on nitpick loop | 4h — **SHIPPED** |
| debate-judge | I1+I2 — structured REVISE feedback + addressed-detection | 5h — **SHIPPED** |
| deliberate-execute | I1 — synthesis-verifier gate | 4h — **SHIPPED** |
| stigmergy | I2 — per-session heat | 3h — **SHIPPED** |

### Tier 3 (deeper)

| Pattern | Item | Effort |
|---|---|---|
| council | I1 — convergence-detection auto-stop | 3h — **SHIPPED** (post 2.1) |
| role-differentiated | I1 — strict-mode role enforcement | 2h — **SHIPPED** |
| role-differentiated | I3 — role intro drift / per-sweep clarification | 3h |
| stigmergy | I3 — cold-file seeding | 3h |

---

## Phase 5 — Queued non-pattern UI ad-hoc · ~5 hours total

| # | Item | Source | Effort | Status |
|---|---|---|---|---|
| 5.1 | Heat-tab file-tree toggle (VSCode-style explorer) | STATUS.md | 2-3h | **SHIPPED** (next commit) |
| 5.2 | Message inspector markdown rendering (react-markdown + remark-gfm) | STATUS.md | 1-2h | **SHIPPED** (next commit) |

---

## Phase 6 — Performance: continue TanStack Query migration · ~10 hours total

| # | Item | Effort | Status |
|---|---|---|---|
| 6.1 | Migrate `useLiveSwarmRunMessages` fully to TanStack Query | 3h | **DEFERRED** (2026-04-24) — existing implementation already has cooldown + trailing-merge + `applyLocally` partial-merge fast path AND mirrors writes into TQ cache via `setQueryData`. Full migration would either regress those optimizations or re-implement them on top of TQ — risk without measurable payoff. Re-evaluate if TQ-canonical source becomes a hard requirement. |
| 6.2 | Migrate `useLivePermissions` | 1h | **DEFERRED** (2026-04-24) — SSE-coupled (permission.asked / replied events drive local state); TQ would need a manual setQueryData layer. Same architectural pattern as 6.1: existing code already covers the use case correctly. |
| 6.3 | Migrate `useSessionDiff` | 1h | **SHIPPED** (next commit) — clean migration; per-(session, lastUpdated) cache key gives free dedup across drawer open/close cycles + cross-component sharing. 5-min staleTime since diff is immutable for a turn-completion timestamp. |
| 6.4 | Per-session gating (don't fetch hidden sessions) | 2h | **SHIPPED** (next commit) — `useLiveSwarmRunMessages` gains `visibleSessionIDs?` parameter; SSE event handler skips refetch for hidden sessions; `applyLocally` partial-merge fast path still keeps slots fresh on visible turn streaming. Default undefined = all visible (backward compat). |
| 6.5 | `/api/swarm/run/:id/snapshot` aggregator endpoint | 4h | **SHIPPED** (`c85724a`) — single endpoint replaces 5 cold-load round-trips; verified 4.5x cold-compile speedup, 3x warm-cached |
| 6.6 | **Page load latency** — 15s blank + 30s before board data | 3h | **DOCUMENTED via 15a/b** (`c85724a`) — measured 4.5x cold / 3x warm-cached speedup of `/snapshot` aggregator vs the 5 separate endpoints. Page wiring to actually CONSUME the snapshot is a separate task (would migrate `useSwarmRun` etc.); deferred. The endpoint is built + verified. |
| 6.7 | **Auto-stick-to-bottom across chronological panels** | 2h | **SHIPPED** (next commit) — extracted state-machine + multi-pass-snap into shared `lib/use-stick-to-bottom.ts`; applied to swarm-timeline + 6 chronological rails (contracts/iterations/debate/council/phases/map). Timeline regression-verified via `_diag-scroll.mjs` (gap=16px at every t-sample 8s-25s). Sorted-differently rails (strategy newest-first; roles/board by metric; heat hot-first; plan natural-top) intentionally skipped — top-anchor is correct for those. |
| 6.8 | **`latest ↓` button across chronological panels** | 1h | **SHIPPED** (next commit) — same 6 rails got `<ScrollToBottomButton scrollRef={…} />` colocated with the scroll body. Threshold 80 px. Visible only when content overflows + user is scrolled away. Trivial-fit content (small lists) correctly hides the button. |
| 6.9 | **Message inspector right-panel empty state** | 2h | **SHIPPED** (next commit) — page.tsx exposes `selectSession(sessionID)` that maps to the agent inspector via the agents array. iterations / roles / map rails wire row clicks to it (rows directly map to sessions). debate / council rails accept the prop but defer inner cell-level wiring (rounds-as-rows) to a v2 — page no longer breaks because the prop is accepted. Phases / strategy / contracts skip wiring (rows are board-items, not sessions). |
| 6.10 | **F7 preflight is blind to opencode's assembled context** — F7 sizes only the work-prompt text we POST (~1K), not the full conversation history + tool definitions opencode assembles before calling the model. Workers in `run_modm7vsw_uxxy6b` cumulatively hit 128K (gemma4's full window) without F7 ever logging a WARN or refusal. Fix options: (a) read `/session/:id`'s last-message tokens via opencode API and warn when next-turn estimate ≥ 60% / 85% of model limit; (b) sum past assistant `tokens.input` per session and project forward. Pairs with F1 watchdog so we have BOTH a "model can't fit any more" signal AND a "model went silent" signal. Per user 2026-04-24 — workers consumed 80-130k each in 4 rejected turns. | 2h | **SHIPPED** (next commit) — went with option (a): in `postSessionMessageServer`, fetch latest assistant message's tokens.input + cache + output as baseline, project forward with new prompt's estimate; refuse ≥85% / WARN ≥60% of model limit. Failure modes (message fetch fails) fall through to layer-1-only check, never block dispatch. |
| 6.11 | **Lane chip: show role, not provider** — replace the inline `ProviderBadge` in the timeline lane header with a role chip (planner / worker-N / orchestrator / judge / generator-N / critic / member-N / mapper-N / synthesizer) sourced from `roleNames` map. Provider info stays in the lane's hover tooltip. Already SHIPPED in next commit; queueing for cross-pattern validation against fresh runs. | — | **SHIPPED** (pending validation) |
| 6.12 | **edit-tool retry-loop detection** — observed against `run_modm7vsw_uxxy6b` worker-2 (`ses_…JyJf5W`): 101 consecutive `edit` tool errors, all "Could not find oldString in the file. It must match exactly..." with the model retrying near-identical wrong oldStrings. opencode's per-turn tool cap doesn't break this loop on gemma4:31b-cloud. Fix: track consecutive same-tool-error count per session in `coordinator.ts::tickCoordinator`'s wait loop; on N (=10?) consecutive `edit` errors with the same error message, abort the turn and mark the item stale with a `[edit-loop]` note. | 2h | **SHIPPED** (next commit) — `waitForSessionIdle` tracks the trailing-suffix count of identical-tool-identical-error parts; at TOOL_LOOP_THRESHOLD=10 aborts with `reason: 'tool-loop'`. Coordinator surfaces 'tool-loop' in the `retryOrStale` reason text; planner re-throws as "tool-loop (model stuck on a tool error)". |

---

## Phase 7 — Live-test backlog (2026-04-24 multi-pattern run) · ~12h

Observations from the live run against `run_modm7vsw_uxxy6b` and the
ongoing `run_modn6mrg_hxvssz`. Many of these had quick fixes shipped
during the live test BUT WERE NOT VERIFIED via Playwright before
"shipped" was claimed. Per user feedback 2026-04-24, the new
discipline is: each item gets a Playwright probe via
`scripts/_preview-screenshot.mjs` before promoting from
**SHIPPED-UNVERIFIED** → **VERIFIED**.

Some items are diagnoses (no code action) or product-validation
moments (F1 watchdog firing). Marked accordingly.

| # | Observation | Status | Verification |
|---|---|---|---|
| 7.Q1 | Auto-stick-to-bottom on entry (timeline) | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — 11 rows · scrollTop=0 · distance-from-bottom=0px (atBottom). | — |
| 7.Q2 | `latest ↓` button visibility | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — `[aria-label="scroll to latest"]` present in DOM (opacity 0 = hidden because at-bottom, correct behavior). | — |
| 7.Q3 | Inspector right panel empty for new tab rows | DIAGNOSED + queued as 6.9 | — |
| 7.Q4 | Roster badge 0/5 1/5 | DIAGNOSED (intentional: 1 dispatch/tick + critic gate) | — |
| 7.Q5 | Worker session 101 `edit` errors | DIAGNOSED + queued as 6.12 | — |
| 7.Q6 | Status chip in roster rows | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — 2/2 roster rows contain a status word ("build #1error", "build #2idle"). | — |
| 7.Q7 | Directive width in topbar | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — directive button width 195px (cap 240) with `max-w-[240px]` class. | — |
| 7.Q8 | Hard refresh stick-to-bottom (re-reported) | **VERIFIED** — same Q1 probe (atBottom on fresh load). | — |
| 7.Q9 | Parts filter multi-select + show all 12 | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — multi-select popover lists all 12 part types: text, reasoning, tool, subtask, agent, patch, file, step-start, step-finish, snapshot, compaction, retry. | — |
| 7.Q10 | react-scan default-on annoying | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — no react-scan overlay in DOM by default. | — |
| 7.Q11 | Lane meter swap to in-first | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — lane renders `in 397k` then `out 2.7k` (in-first DOM order confirmed via compareDocumentPosition). | — |
| 7.Q12 | Run-anchor: status-only | SHIPPED-VERIFIED (`790d2d3`) — Playwright found "ERROR" rendered ✓ | — |
| 7.Q13 | Picker 5s latency | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — time-to-first-row 24ms (target < 1000ms). | — |
| 7.Q14 | Run shows live but actually error | SHIPPED-VERIFIED (`135ce9b`) — Playwright found "ERROR" ✓ | — |
| 7.Q15 | Remove status dot from picker rows | **VERIFIED** (run_modwae52_unv2lt, 2026-04-25) — 0/12 picker rows carry a ≤12px rounded-full status dot. | — |
| 7.Q16 | Run not in listview after hard refresh | **VERIFIED PASS** (`bb59603`) — the run IS in the picker; earlier failed probe was searching for the full `run_…` ID but the picker uses `idTail()`. Diag confirms `bodyContainsModm7vsw_uxxy6b: true`. |
| 7.Q17 | F1 watchdog firing | PRODUCT VALIDATION — F1 worked: WARN at 90s + abort at 240s on 3+ separate sessions during pattern 2. No code action. Update POSTMORTEMS ledger to VERIFIED. | Confirmed in `/tmp/dev-server.log` |
| 7.Q18 | Test-run hygiene (track + tear down dev/opencode/monitor) | OPEN — see `memory/feedback_test_run_hygiene.md`. Recurring failure across 5+ runs. Need: pre-flight teardown checklist, end-of-run TaskStop discipline, never-`disown`-tracked-procs rule. | Operational; verify by `ss -tlnp` showing only intended ports + matching `1 shell` indicator in user UI. |
| 7.Q19 | **Pattern-specific tabs misplaced (LEFT → MAIN)** | 6h | **SHIPPED** (`1c5c169`) — 8 components moved; verified across 2 patterns (blackboard + orchestrator-worker). Other 6 patterns (council/critic-loop/debate-judge/map-reduce/role-differentiated/deliberate-execute) follow same conditional logic; full per-pattern verification needs live runs of each. |

**Q-suite replay 2026-04-25 (run_modwae52_unv2lt, post-run dormant state):** 6 PASS / 0 FAIL / 3 SKIP. Structural probes (Q2 latest-button, Q7 directive cap, Q9 parts filter 12/12, Q10 react-scan-off, Q13 picker 9ms, Q15 no-status-dot) reproduce. Content-prerequisite probes (Q1+Q8 timeline rows, Q6 roster rows, Q11 lane in/out pair) skip cleanly because the run's `parts` table is empty after retention/replay — canonical content-bearing observations remain those captured in the rows above. No regressions.

**Validation-8 follow-ups (2026-04-26 multi-pattern run, in flight 06:51Z–~15:01Z):**

| # | Observation | Status | Verification |
|---|---|---|---|
| 7.Q20 | Retro page blank when clicked from runs list | **SHIPPED** 2026-04-26 — both fixes landed in same batch as 7.Q24. Fix A: `stopAutoTicker` (ticker patterns) and `finalizeRun` (non-ticker patterns) now fire `generateRollupById` after the abort cascade settles, fire-and-forget so a slow rollup doesn't gate stop semantics. Dynamic import keeps stop.ts/finalize-run.ts's static deps small. Fix B: empty-state's curl-instruction replaced with a "generate rollup" button (`components/retro-view.tsx::RollupGenerateButton`) that POSTs to the existing endpoint and reloads on success. Curl recipe still shown below the button as a backup. | tsc clean, 254/254 tests green. Verifier: spawn a fresh run, let it stop, navigate to /retro/<id> — page populates without manual rollup. Older validation-8 runs: clicking the button fires the rollup + reloads. |
| 7.Q21 | Ticker `totalCommits` resets to 0 on stop | **SHIPPED** 2026-04-26 — diagnosis was wrong: the field never resets. `totalCommits` was on `TickerState` but the `snapshot()` function in `auto-ticker/state.ts` didn't propagate it into the public `TickerSnapshot`, so the API serialized it as undefined and my probe's `// 0` defaulted missing → 0. Fix: added `totalCommits` to the `TickerSnapshot` interface (server + client mirror in `lib/blackboard/live.ts`) and to the snapshot() return shape. Defaults `s.totalCommits ?? 0` on the field so legacy HMR-carryover entries don't crash. | tsc clean, 254/254 tests green. Verifier: probe `/api/swarm/run/<id>/board/ticker` post-cap-stop — `totalCommits` returns the real count (e.g., 30) instead of being absent. |
| 7.Q22 | debate-judge "WINNER from silent drafts" | **SHIPPED** 2026-04-26 — `lib/server/debate-judge.ts`. Filter `msgs` to exclude IDs in `knownByGenerator.get(sid)` before passing to `extractLatestAssistantText`. Now a silent freeze on the actual draft turn surfaces as `text=null`, which falls through to the existing `present.length < 2` abort gate instead of leaking the generator's intro-prompt prime-ack into the judge's draft pool. | tsc clean, 254/254 tests green. Verifier: a debate-judge run where one generator forcibly stalls now hits `too-few-drafts` abort instead of declaring a WINNER from prime-acks. |
| 7.Q23 | Serial-critical patterns fragile under opencode silent-freeze | DIAGNOSIS — empirically reconfirmed today: orchestrator-worker (orchestrator silent → 8 commits then dead) and debate-judge (both generators silent → bogus winner) both degraded under pure GEMMA. Parallel-redundant patterns (blackboard 30 / role-differentiated 30 / council 9 drafts / map-reduce synth landed) all completed clean. No code action — just confirms `reference_pattern_reliability_ranking.md` and reinforces "pick by fragility profile". | — |
| 7.Q24 | Auto-firing rollup on run end | **SHIPPED** 2026-04-26 — folded into 7.Q20 fix A. `stopAutoTicker` covers ticker-backed patterns (blackboard, orchestrator-worker, role-differentiated, deliberate-execute exec-phase); `finalizeRun` covers non-ticker patterns (council, map-reduce, debate-judge, critic-loop). Both fire-and-forget the rollup after their respective abort cascades settle. | tsc clean, 254/254 tests green. Same probe as 7.Q20 — rollup count > 0 on every freshly-stopped run. |
| 7.Q25 | Plan tab unreachable when heat has data | **SHIPPED** 2026-04-26 — `components/left-tabs.tsx`. Took fix (B): added a `prevHeatLenRef` and only fire the plan→heat auto-flip on the `0→>0` transition. Subsequent user clicks on "plan" stick. Preserves the original "promote heat when it first appears" semantics. | tsc clean, 254/254 tests green. Manual verification: click "plan" while heat populated → plan content stays. |
| 7.Q26 | Decomposition wave 2 (next 8 large files) | **IN PROGRESS** 2026-04-26 — `app/page.tsx` 1392 → 1206 lines (-186, 13.4%) across 5 passes. Pass 1: `use-modal-state.ts` (8 modal flag pairs → stable openers/closers) + `page-modals.tsx` (8 dynamic overlay renders). Pass 2: `use-selection-state.ts` (focusedMsgId / selectedAgentId / selectedFileHeat / drawerOpen + 7 handlers). Pass 3: `use-cost-cap-block.ts` (costCapBlock + safePost wrapper). Pass 4: `use-global-keybindings.ts` (Cmd-K / Cmd-N). Pass 5: `use-view-state.ts` (leftTab + runView + focusTodoId + jumpToTodo + auto-reset effect). Remaining ≥500-line files unchanged: `new-run-modal.tsx` (900), `swarm-timeline.tsx` (779), `retro-view.tsx` (629), `spawn-agent-modal.tsx` (626), `board-rail.tsx` (623), `turn-cards-view.tsx` (619), `agent-roster.tsx` (557), `contracts-rail.tsx` (513). | tsc clean, 254/254 tests green throughout. Future: JSX render-block splits (pattern-rail switch, SwarmComposer wiring), then component-side files. |
| 7.Q27 | Cap-stop runs mistagged as `error` in picker | **SHIPPED** 2026-04-26 — `lib/server/swarm-registry.ts:464`. Took fix (A): when `info.error.name === 'MessageAbortedError'` (the precise opencode shape for any operator-initiated abort — cap-stop, manual /stop, F1 silent-watchdog), classify as `idle` instead of `error`. Probed the actual error shape on validation-8 runs: cap-stop produces `{name: "MessageAbortedError", data: {message: "Aborted"}}`; genuine opencode-frozen runs have `error: null` (so they classify as `idle` already, no change needed). Real assistant errors (provider failures, parse errors) carry different error names and continue to escalate to `error`. | tsc clean, 254/254 tests green. Manual verification: run_mofeufuh_d6i8ek + run_mofnnfp8_1k5nue (cap-stop runs from validation-8) re-classify as `idle` not `error` next picker poll. |
| 7.Q28 | "Live" status doesn't reflect ticker activity | **SHIPPED** 2026-04-26 — `lib/server/swarm-registry.ts deriveRunRow`. Empirical reproduction during validation-8 session 2: a 60-min orchestrator-worker run reported `idle` in the picker every time workers completed a turn between dispatches (per-session classifier correctly returned `idle` for each, so the run-level fold did too — but the auto-ticker was actively dispatching, work IS happening). Fix: when the run-level fold says `idle`, dynamic-import getTickerSnapshot and check if a non-stopped ticker exists; if so, promote to `live`. Stopped tickers don't override (the run really is done). Decoupled via dynamic import so swarm-registry doesn't statically depend on the auto-ticker module. | tsc clean, 254/254 tests green. Empirical verifier: load picker mid-run on a ticker pattern, status shows `live`, not `idle`. |
| 7.Q29 | Picker sort buries newest runs under older same-rank runs | **SHIPPED** 2026-04-26 — `components/swarm-runs-picker.tsx`. Replaced status-rank-then-time sort with live-first-then-strictly-newest. Live runs still pin to the top (original "in-flight runs surface first" intent preserved), but stale/error/idle now interleave by createdAt instead of bucketing. Status dot color continues to communicate the bucket for non-live rows. | tsc clean, 254/254 tests green. Manual verification: open picker after validation-8; today's runs are at the top regardless of (mis)status. |
| 7.Q30 | Inspector pane empty on timeline-row clicks | **NOT REPRODUCIBLE** 2026-04-26 — verified with Playwright headless probe against run_moflgdpi_xf703h (council) and run_mofeufuh_d6i8ek (blackboard): clicking a timeline chip slides the right-side Drawer open with the populated MessageInspector (verified by inspecting the rendered ASIDE element's textContent — full message details visible). Zero pageerror / console-error events on either run. Likely your previous report was either a stale-cache state pre-#7.Q27 (the cap-stop runs were mistagged `error`, which may have triggered a downstream fallback path) or a click on the lane-background (the timeline scroll container clears focus when clicked between chips — `swarm-timeline.tsx:299-301`). Re-test after the observability + retro batches landed; reopen if still broken with a specific click-target description. | Verified working empirically; needs user re-test for closure. |
| 7.Q31 | Some runs fail to render when navigated directly | **NOT REPRODUCIBLE** 2026-04-26 — Playwright headless probe against both URLs returns full populated UI: council shows 181 timeline events + 3 build session lanes + plan/roster/heat tabs all populated; map-reduce shows 157 events + synthesis section ("SYNTHESIS READY", 3 build outputs, "OPEN SYNTHESIS →" button) + plan rail with all 6 todos. Zero pageerror / console-error events. The earlier "doesn't load" was likely browser-side cache state at the time of the report (the pages returned 200 server-side, valid /snapshot JSON, reachable session messages even then). Re-test after this batch landed; reopen if still broken with browser console paste. | Verified working empirically; needs user re-test for closure. |
| 7.Q32 | Council kickoff fires Round N prompts but doesn't wait for responses | **SHIPPED** 2026-04-26 — `lib/server/council.ts`. Added a final `harvestDrafts` call after the round loop completes that waits for the maxRounds responses, then captures them as a finding via `recordPartialOutcome` with phase `complete`. No more `parts=0` orphan placeholders — opencode marks the final-round messages as `time.completed` set, and the final votes (which the prompt explicitly asks for) are durably visible in /retro and on the board. | tsc clean, 254/254 tests green. Verifier: spawn a fresh council run, after auto-rounds complete probe the session messages — the trailing assistant turns have `time.completed` set, and a `kind=finding` board item carries the votes. |
| 7.Q33 | Orchestrator-actions buttons silently no-op | **SHIPPED** 2026-04-26 — `app/page.tsx:1121` + `components/orchestrator-actions-strip.tsx` header comment. The "nudge → status report / re-strategize / focus check" buttons posted to the orchestrator session with `agent: 'orchestrator'`. Per `reference_opencode_agent_silent_drop.md`, opencode silently drops POSTs whose agent isn't a built-in (build/compaction/explore/general/plan/summary/title) — returns 204, never persists. Result: every click 204'd, no message landed, no observable event. Surfaced 2026-04-26 by user during validation-8 session 2 ("orchestrator buttons but they are not working"). Fix: drop the agent field entirely; opencode falls back to the session's default. Comment updated to flag the trap so future code doesn't reintroduce it. | tsc clean. Empirical verifier: spawn an orchestrator-worker run, click any of the three buttons, confirm a new user message appears in the orchestrator session's transcript and a follow-up assistant turn lands. |
| 7.Q34 | opencode-frozen recurrence on orchestrator-worker | **PARTIALLY SHIPPED** 2026-04-26 — orchestrator-on-GLM fix lands cleanly but exposes a deeper second bug (Q42). `lib/swarm-patterns.ts` swap from `Array(n).fill(GEMMA)` to `[GLM, ...rest GEMMA]` works as designed: Q34-verify-v2 (run_mog101p0_7js6lt) shows the orchestrator session emitting 27 real tool calls + a real todowrite that seeded 9 todos + 4 criteria. Auto-ticker started, no opencode-frozen. The original Q34 symptom (orchestrator silent at ~min 12) is closed. **However**, the workers (GEMMA) in this run produced pseudo-tool-text exclusively (0 real tool calls, 0 patches across both worker sessions, 0 workspace files modified) — see Q42. So the run "completed" 9 todos as phantom done-transitions while editing nothing. | Orchestrator emits real tools + real todowrite → ✓ (decisively closed). Workers actually edit files → tracked separately as Q42. |
| 7.Q42 | Workers (GEMMA) produce pseudo-tool-text in orch-worker context | **SHIPPED + (C) CONFIRMED LIVE** 2026-04-26 — fix path (D) shipped earlier this turn (phantom-completion guard in `dispatch.ts`). Q42-verify run today (run_mog2uh9d_enn1p6) **confirmed (C) ollama-cloud GEMMA drift empirically**: across 18+ worker dispatches, every single GEMMA worker turn produced text-only pseudo-tool-XML responses (ranging 8 chars to 17,394 chars), zero real tool/patch parts, zero workspace files modified. The guard fired on every one — bounced via `retryOrStale` with note `[phantom-no-tools]`. Plus 2 F1 hard-aborts when workers froze entirely after producing pseudo-text. **Result: zero phantom commits shipped, board carries truth (`totalCommits: 0`, todos go stale rather than false-done).** Hypotheses (A)/(B) ruled out by spawn-flow code diff earlier; (C) is the cause. Mitigations: (1) the guard always-on (just shipped), (2) at the workhorse-model level, GEMMA is currently unreliable for tool-using work — consider switching workers to GLM until ollama-cloud GEMMA stabilizes (separate per-pattern decision; not in this commit's scope). | tsc clean, 254/254 tests green. (D) guard verified live with 18+ caught phantoms in run_mog2uh9d_enn1p6. (C) confirmed. |
| 7.Q43 | Inspector tokens/cost always shows '-' on non-step-finish parts | **SHIPPED** 2026-04-26 — `lib/opencode/transform.ts toMessages`. Pre-fix: only `step-finish` parts had `tokens` populated, `cost` was never set. Other parts (text/reasoning/tool/patch) showed `-` in the inspector's tokens/cost stat strip — but opencode tracks tokens + cost at the message level, not per-part. Fix: surface `m.info.tokens?.total` (with step-finish partial as fallback for mid-stream) and `derivedCost(m.info)` on every part of an assistant message. Clicking any chip in the inspector now shows the message's totals — the user's natural mental model. | tsc clean, 254/254 tests green. Empirical verifier: click a `text` or `tool` part in the inspector — tokens/cost stat strip shows real numbers. |
| 7.Q44 | Inspector "TO human operator" misleading on internal parts | **SHIPPED** 2026-04-26 — `components/inspector/sub-components.tsx MessageInspector`. The route panel previously rendered `FROM agent → via reasoning → TO human operator` for reasoning / step-start / step-finish parts. But those are the model's internal thinking + opencode bookkeeping — there's no recipient. Showing "TO human operator" suggested the agent was speaking to the human when it wasn't. Fix: hide the `to` AgentPill row when `msg.part` is `reasoning` / `step-start` / `step-finish`. Other parts (text/tool/patch/agent/subtask) keep the recipient pill — those have real targets. | tsc clean, 254/254 tests green. Empirical verifier: click a `reasoning` chip in the inspector — route panel shows only the `FROM` pill + the "via reasoning" header, no spurious `TO` row. |
| 7.Q45 | Run with all-phantom-bounce todos never auto-stops | **SHIPPED** 2026-04-26 — `lib/server/blackboard/auto-ticker/tick.ts isIdleOutcome`. Q42 bounces produce `status: 'stale'` outcomes, and the original `isIdleOutcome` only counted `'skipped'` as idle — so phantom-bounce-stales reset `consecutiveIdle` to 0 every tick. With every dispatch coming back as a phantom-bounce, the run never reached the 6-tick auto-stop threshold and spun forever (observed live on run_mog2uh9d_enn1p6: 18+ phantom bounces, board exhausted to all-retry-stuck, ticker still running for 20+ minutes). Picker correctly showed `live` (Q28 ticker-aware logic) — the bug was below: the ticker should have STOPPED. Surgical fix: extend `isIdleOutcome` to count `stale` outcomes whose reason includes `'phantom-no-tools'` as idle, same as `skipped`. Legitimate stales (CAS-drift, turn-timeout) still reset the counter — those represent real session activity. | tsc clean, 254/254 tests green. Empirical verifier: run with all-phantom workers reaches `auto-idle` stop within ~60s of the board exhausting to retry-stuck, instead of spinning forever. |
| 7.Q35 | Picker can't distinguish opencode-frozen from clean stop | **SHIPPED** 2026-04-26 — `lib/server/swarm-registry.ts deriveRunRow`. Extended Q28's dynamic-import block to also read `ticker.stopReason`. Failure-mode reasons (`opencode-frozen` / `zen-rate-limit` / `replan-loop-exhausted`) promote `idle` → `error` so the picker's red dot tells truth. Graceful reasons (caps / manual / auto-idle / operator-hard-stop) keep `idle`. Mirrors Q40's failure-set used in retro-view. | tsc clean, 254/254 tests green. |
| 7.Q36 | Validation driver wastes wallclock when ticker stops early | **SHIPPED** 2026-04-26 — `scripts/_validation-8-patterns.sh active_sleep`. Added `ticker_stopped` helper that probes `/board/ticker` and returns 1 when `.stopped == true`. Inside the active_sleep poll loop, after each PROBE_INTERVAL sleep, check the ticker for ticker-backed patterns; if stopped, log `EARLY-STOP` with the remaining wallclock and return immediately. Saves up to 50+ min per failed run. Limited to ticker patterns (non-ticker patterns ride the kickoff coroutine, no equivalent probe). | A blackboard run that hits commits-cap at minute 30 advances to the next pattern within ≤5 min instead of waiting out the remaining 30. |
| 7.Q37 | No regression test for invalid `agent` param silent-drop | **SHIPPED** 2026-04-26 — went with option (C) typed enum. Added `OpencodeBuiltinAgent` union in `lib/opencode/types.ts` covering opencode's 7 built-ins. Tightened `postSessionMessageBrowser` and `postSessionMessageServer` signatures to take `agent?: OpencodeBuiltinAgent` instead of `agent?: string`. Tightened `opencodeAgentForSession` return type and `SafePostOptions.agent` to match. **The compile-time check immediately surfaced two pre-existing silent-drop bugs**: (1) `lib/server/orchestrator-worker.ts:113` was passing `agent: 'orchestrator'` on every orchestrator-worker run's intro post — the role-framed intro had been silently 204'd indefinitely; **likely contributing cause of Q34** (opencode-frozen recurrence at ~min 12 on every orch-worker run — without proper role framing, GEMMA may loop on todowrite); (2) `app/page.tsx:1160` SwarmComposer was passing `agent.name` (e.g. 'build #1', 'member-1') for per-agent sends — every per-worker send via the composer had been silently dropping. Both fixed: orch-worker now omits the agent param, composer routes by sessionID (`targetAgent.sessionID`) which is the correct path anyway. | tsc clean, 254/254 tests green. Future: any code that tries to pass a non-built-in string to opencode's agent field fails at compile time. Watch Q34 next orchestrator-worker run — does the freeze recur with the intro now actually landing? |
| 7.Q38 | Inspector on aborted-but-rendered sessions | **NOT REPRODUCIBLE** 2026-04-26 — Playwright probe earlier this session (`/tmp/click-and-check.mjs` against run_moflgdpi_xf703h council + run_mofeufuh_d6i8ek blackboard, both stopped/aborted runs) showed inspector populating consistently on timeline-chip click with full message content (role, agent, model, tokens, reply chain). 0 console errors, 0 stale-state divergence. The hypothetical SSE-late-partial scenario doesn't manifest in our actual flow because `useLiveSession` reads from a stable TanStack Query cache that's settled by the time the inspector renders. Reopen if a real divergence is observed. | Verified empirically; needs user re-test only if a specific symptom recurs. |
| 7.Q39 | Runs-list cache TTL too loose for "I just spawned" feedback | **SHIPPED** 2026-04-26 — `components/new-run-modal.tsx`. After a successful `POST /api/swarm/run` and before the navigation, fire `queryClient.invalidateQueries({ queryKey: SWARM_RUNS_QUERY_KEY })`. Forces an immediate refetch instead of waiting for the next 4s poll. Imported `useQueryClient` + `SWARM_RUNS_QUERY_KEY`; total addition ~5 lines. | tsc clean, 254/254 tests green. Empirical: spawn a run, navigate to the destination, open the picker — new run is at the top within ~500ms instead of up to 4s. |
| 7.Q40 | /retro page UX for failure-mode runs | **SHIPPED** 2026-04-26 — `app/retro/[swarmRunID]/page.tsx` + `components/retro-view.tsx`. Server component now fetches `getTickerSnapshot(swarmRunID)` (sync, persisted to SQLite via Q21 path) and threads it through to RetroView. Header renders a red chip when `ticker.stopped && stopReason ∈ {opencode-frozen, zen-rate-limit, replan-loop-exhausted}` — formatted as "stopped at <Xm> · <stopReason>" with minute mark computed from startedAtMs/stoppedAtMs. Side fix: `lib/blackboard/live.ts` TickerSnapshot type was missing `operator-hard-stop` from the stopReason union (drift from auto-ticker/types.ts) — synced. | tsc clean, 254/254 tests green. /retro/<id> for an opencode-frozen run now shows a prominent header chip; cap-stop runs show no chip (no failure to surface). |
| 7.Q41 | Opencode log spam: `error= failed` every 30s | **SHIPPED** 2026-04-26 — `lib/server/opencode-log-tail.ts NOISE_PATTERNS`. Sweep of dev logs found 179 occurrences of `ERROR ... service=server error= failed` in a 1h validation session — fires every 30s with empty error field, while opencode's session POSTs continue succeeding. An internal periodic check that's logged at ERROR level even on normal operation. Drowns the actual error signal F2 was wired to surface. Filter is conservative — any opencode error with non-empty `error=...` detail (e.g. `error="ECONNREFUSED ..."`) won't match this pattern and will still surface. | After dev restart, no `[opencode] ERROR ... service=server error= failed` lines in dev log. Real opencode errors with detail (provider unreachable, etc.) still surface. |

---

## Total Estimate

| Phase | Items | Effort |
|---|---|---|
| 0 — Tactical fixes | 7 | ~3h |
| 1 — Pattern tabs T1 | 6 | ~17h |
| 2 — Pattern tabs T2 | 3 | ~12h |
| 3 — Postmortem fixes | 6 | ~10h |
| 4 — Pattern mechanics | ~20 | ~50h |
| 5 — Ad-hoc UI | 2 | ~5h |
| 6 — Perf + UX | 9 | ~18h |
| 7 — Live-test backlog | 19 | ~18h (Q19 is a 6h architectural refactor) |
| **Total** | **~72** | **~133 hours** |

That's roughly 2.5-3 weeks of focused work. We can ship in increments — every Phase-0 fix and every Phase-1 tab is independently mergeable.

---

## Recommended sequencing

**Week 1:** Phase 0 (3h, day 1 morning) → Phase 1 contracts tab (3h, day 1 afternoon) → Phase 1 remaining 5 tabs (15h, days 2-3) → Phase 3 F1 + F2 (4h, day 4) — ships 6 user-visible features + observability infrastructure.

**Week 2:** Phase 2 tabs (12h) + Phase 3 remaining (6h) + Phase 5 ad-hoc UI (5h) — closes design backlog, finishes observability layer.

**Week 3:** Phase 4 mechanics gaps (~50h) — backend hardening based on what real runs reveal once the new observability is in place.

**Week 4 (optional):** Phase 6 perf migration if there's still latency the user feels.

---

## Update protocol

When an item ships:
1. Update its source doc's ledger entry → `SHIPPED + <commit hash>`
2. Update this doc's Status column
3. Run validation probe (if any) against next real run; promote to `VERIFIED` if passes
4. Cross-reference in commit message: `(closes IMPLEMENTATION_PLAN.md item N.M)`
