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
| 0.5 | Reconcile `opencode.json` model context overrides (F6) | POSTMORTEMS | 15m | PROPOSED — outside repo, needs user-side edit |
| 0.6 | Add `OPENCODE_LOG=debug` to launcher (F3) — gates F5 below | POSTMORTEMS | 5m | PROPOSED — outside repo (.ps1 launcher), needs user-side edit |
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
| 3.4 | F5 | Session-level error read (after F3 enables debug logging) | 1h | PROPOSED | P1, blocked on 0.6 |
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
| 6.9 | **Message inspector right-panel empty state** | 2h | **OPEN** — diagnosed as routing gap (new pattern-tab rows don't wire into focusMessage/selectAgent/selectFileHeat). Same item as Item 10 in the priority sequence. Needs per-rail design discussion before code. |
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
| 7.Q1 | Auto-stick-to-bottom on entry (timeline) | SHIPPED-UNVERIFIED (`f2733a2` + `c0629fe`) | Playwright: scroll to bottom of timeline page, assert `scrollTop === scrollHeight - clientHeight`. User reported still broken after first fix; second-attempt 3-second 200ms-ticker shipped but unconfirmed. |
| 7.Q2 | `latest ↓` button visibility | SHIPPED-UNVERIFIED (`f2733a2`) — threshold lowered 200→80px | Playwright: scroll to top, assert button is visible in DOM. |
| 7.Q3 | Inspector right panel empty for new tab rows | DIAGNOSED + queued as 6.9 | — |
| 7.Q4 | Roster badge 0/5 1/5 | DIAGNOSED (intentional: 1 dispatch/tick + critic gate) | — |
| 7.Q5 | Worker session 101 `edit` errors | DIAGNOSED + queued as 6.12 | — |
| 7.Q6 | Status chip in roster rows | SHIPPED-UNVERIFIED (`f2733a2`) | Playwright: assert each `.roster-row` contains text matching `idle\|working\|error\|...` |
| 7.Q7 | Directive width in topbar | SHIPPED-NOT-LANDED (`f2733a2`) — Playwright found full directive still rendered. Fix didn't take effect. | Re-investigate: Popover wrapper may be overriding the `truncate max-w-[240px]` cap. |
| 7.Q8 | Hard refresh stick-to-bottom (re-reported) | SHIPPED-UNVERIFIED (`c0629fe`) | Playwright on fresh load |
| 7.Q9 | Parts filter multi-select + show all 12 | SHIPPED-UNVERIFIED (`c0629fe`) | Playwright: open parts dropdown, count visible part-type rows = 12 |
| 7.Q10 | react-scan default-on annoying | SHIPPED-UNVERIFIED (`c8db06c`) | Playwright on fresh load — assert no rerender outlines visible |
| 7.Q11 | Lane meter swap to in-first | SHIPPED-UNVERIFIED (`ba58d05`) | Playwright: rendered text contains `in <X>` BEFORE `out <Y>` per lane |
| 7.Q12 | Run-anchor: status-only | SHIPPED-VERIFIED (`790d2d3`) — Playwright found "ERROR" rendered ✓ | — |
| 7.Q13 | Picker 5s latency | SHIPPED-UNVERIFIED (`135ce9b` — 30s page poll re-enabled) | Playwright: open picker, time-to-first-row should be under 1s after page warm |
| 7.Q14 | Run shows live but actually error | SHIPPED-VERIFIED (`135ce9b`) — Playwright found "ERROR" ✓ | — |
| 7.Q15 | Remove status dot from picker rows | SHIPPED-UNVERIFIED (`135ce9b`) | Playwright: open picker, assert no `.rounded-full` color dot inside row's status column |
| 7.Q16 | Run not in listview after hard refresh | **VERIFIED PASS** (`bb59603`) — the run IS in the picker; earlier failed probe was searching for the full `run_…` ID but the picker uses `idTail()`. Diag confirms `bodyContainsModm7vsw_uxxy6b: true`. |
| 7.Q17 | F1 watchdog firing | PRODUCT VALIDATION — F1 worked: WARN at 90s + abort at 240s on 3+ separate sessions during pattern 2. No code action. Update POSTMORTEMS ledger to VERIFIED. | Confirmed in `/tmp/dev-server.log` |
| 7.Q18 | Test-run hygiene (track + tear down dev/opencode/monitor) | OPEN — see `memory/feedback_test_run_hygiene.md`. Recurring failure across 5+ runs. Need: pre-flight teardown checklist, end-of-run TaskStop discipline, never-`disown`-tracked-procs rule. | Operational; verify by `ss -tlnp` showing only intended ports + matching `1 shell` indicator in user UI. |
| 7.Q19 | **Pattern-specific tabs misplaced (LEFT → MAIN)** | 6h | **SHIPPED** (`1c5c169`) — 8 components moved; verified across 2 patterns (blackboard + orchestrator-worker). Other 6 patterns (council/critic-loop/debate-judge/map-reduce/role-differentiated/deliberate-execute) follow same conditional logic; full per-pattern verification needs live runs of each. |

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
