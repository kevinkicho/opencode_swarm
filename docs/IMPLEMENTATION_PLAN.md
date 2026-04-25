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
| 0.7 | Dev wrapper orphan handling — make scripts/dev.mjs detach cleanly | STATUS.md | 1h | PROPOSED |

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
| 6.1 | Migrate `useLiveSwarmRunMessages` fully to TanStack Query | 3h | PROPOSED |
| 6.2 | Migrate `useLivePermissions` | 1h | PROPOSED |
| 6.3 | Migrate `useSessionDiff` | 1h | PROPOSED |
| 6.4 | Per-session gating (don't fetch hidden sessions) | 2h | PROPOSED |
| 6.5 | `/api/swarm/run/:id/snapshot` aggregator endpoint | 4h | PROPOSED |
| 6.6 | **Page load latency** — 15s blank screen + 30s before board data renders (observed 2026-04-24 against `run_modm7vsw_uxxy6b`). Diagnose: which fetch is the long pole — `/api/swarm/run` snapshot, per-session messages fan-out, or board SSE handshake? Profile cold load + identify the blocking waterfall. Likely fixable by 6.5 (snapshot aggregator) collapsing N round-trips into 1. | 3h | PROPOSED |
| 6.7 | **Auto-stick-to-bottom on entry across ALL panels** — landing on a run view should snap to the latest items everywhere (board rail, plan rail, contracts, iterations, debate, strategy, etc.), not just the timeline. As items grow during the run, the view should follow unless the user has scrolled up (48px threshold matches timeline). Today only `swarm-timeline.tsx` has this behavior; the per-pattern tabs and BoardRail render top-anchored. Per user 2026-04-24 — "user should be directed to the bottom and stick at the bottom so growing items as run proceeds will be displayed." | 2h | PROPOSED |
| 6.8 | **`latest ↓` button visibility audit** — user reports the button is no longer visible. Root cause: it's distance-gated at 200px-from-bottom and only renders inside `swarm-timeline.tsx` + `turn-cards-view.tsx`, NOT inside any of the new pattern tabs (contracts/iterations/debate/roles/map/council/phases/strategy/heat). Either lift the button to a shared scroll-container wrapper OR add it per-tab. Pairs with 6.7. | 1h | PROPOSED |
| 6.9 | **Message inspector right-panel empty state** — user reports the inspector shows no information. Investigate: (1) Is the Drawer opening but rendering empty body? (Possible if `msg.body` is empty for the selected message — MarkdownBody renders nothing on empty input; we should fall back to the part's tool input/output preview.) (2) Are the new pattern tabs (contracts/strategy/iterations/etc.) failing to route row-click → inspector at all? Currently only timeline-nodes + roster + heat-rows wire into focusMessage/selectAgent/selectFileHeat; clicking a strategy row, contracts row, iterations row produces nothing. | 2h | PROPOSED |
| 6.10 | **F7 preflight is blind to opencode's assembled context** — F7 sizes only the work-prompt text we POST (~1K), not the full conversation history + tool definitions opencode assembles before calling the model. Workers in `run_modm7vsw_uxxy6b` cumulatively hit 128K (gemma4's full window) without F7 ever logging a WARN or refusal. Fix options: (a) read `/session/:id`'s last-message tokens via opencode API and warn when next-turn estimate ≥ 60% / 85% of model limit; (b) sum past assistant `tokens.input` per session and project forward. Pairs with F1 watchdog so we have BOTH a "model can't fit any more" signal AND a "model went silent" signal. Per user 2026-04-24 — workers consumed 80-130k each in 4 rejected turns. | 2h | PROPOSED |
| 6.11 | **Lane chip: show role, not provider** — replace the inline `ProviderBadge` in the timeline lane header with a role chip (planner / worker-N / orchestrator / judge / generator-N / critic / member-N / mapper-N / synthesizer) sourced from `roleNames` map. Provider info stays in the lane's hover tooltip. Already SHIPPED in next commit; queueing for cross-pattern validation against fresh runs. | — | **SHIPPED** (pending validation) |

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
| **Total** | **~53** | **~115 hours** |

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
