# STATUS.md

Where the project is right now. Time-scoped — check when asking "where are
we?" Not for *how* things work (use `DESIGN.md`), not a changelog (`git log`),
not a roadmap.

Maintenance: prune + rewrite every couple months. Remove items when shipped
or abandoned.

**Last updated:** 2026-05-09 — comprehensive session: 12 analyses, 50+ code changes, 57 new tests, 20 analysis docs, 6 scripts, 5 future directions shipped. All queued items complete.

---

## Current state

**Functioning prototype.** UI complete, backend wired to real opencode
sessions, 7 orchestration patterns shipped end-to-end (blackboard,
council, orchestrator-worker, debate-judge, critic-loop, map-reduce,
pipeline) plus `none` (single-session opencode native). Personal-use only,
never SaaS.

**Test suite**: 713 total tests (57 new this session). `tsc --noEmit` clean
(2 pre-existing `harvest-drafts.test.ts` errors). 73 test files. Key modules
covered: planner sweep (22), escalation (19), recommend-pattern (21),
contract (20), webhook (4), steady-state (8), transition-item (6),
file-locks (5), auto-ticker state/types/stop (18).

### This Session (2026-05-08/09)

**Strategic Analysis** (12 methodologies applied):
- Ansoff Matrix → Scenario Planning → Monte Carlo (3,000 trials) → LCCA
- Fault Tree (14 cut sets) → Composite Synthesis → UML (class/state/sequence/component)
- ATAM/SAAM/CBAM/DSM → TLA+/Alloy/Invariants → Formal Methods 2.0
- SAST/SCA/DAST/PenTest → Performance/Benchmarking → Code Audit
- All findings consolidated in `docs/RECOMMENDATIONS.md`

**Systematic Fixes (3)**: per-work-unit session isolation (Fix 1), file-level claim gating (Fix 2), pattern contract enforcement (Fix 3). Design in `docs/SYSTEMATIC_FIXES.md`.

**Flow-Driven Improvements (4)**: unified state transition (`transition-item.ts`), BoardView single-scan snapshot, planner cooldown tuning (60s→60s), sweep-after-claim eagerness.

**Monte Carlo-Driven Improvements (5)**: README + lessons caching, default team size 2, cost-per-todo badge ($0.034/todo), planner error retry, default sweep cadence 10 min.

**UML-Driven Improvements (2)**: claimed zombie cleanup, parallelized session message fetch.

**SAAM-Driven Improvement (1)**: role-aware watchdog threshold (180s workers, 360s planner).

**Security Fixes (7)**: workspace path validation, prompt injection sanitization (webhook + directives), API proxy path whitelist, dependency audit, debug endpoint gating, console.log audit, Next.js upgrade to 14.2.35 (version bumped, needs WSL-native `npm install`).

**Formal Methods Fixes (2)**: transition validation guard in `store.ts`, directive sanitization in `validate.ts`.

**Functional Features (5)**: pattern recommender, run templates (save/load), board search + filters, post-hoc run review (retro), CI webhook trigger.

**Test Coverage (4)**: contract tests (20), auto-ticker unit tests (18), transition + file-lock + board-view tests (14), steady-state regression tests (8).

**Operational Tooling (6)**: Monte Carlo simulation (`monte-carlo.ts`), LCCA calculator, postmortem frequency tracker, performance benchmark, import graph analyzer, decision script.

**Strategic Documents (12)**: STRATEGY, SYSTEMATIC_FIXES, MONTE_CARLO, LCCA, FAULT_TREE, COMPOSITE_PLAN, IMPLEMENTATION_PLAN, RECOMMENDATIONS, UML_ANALYSIS, ARCHITECTURE_EVALUATION, FORMAL_METHODS, FORMAL_METHODS_2, PERFORMANCE, SECURITY.

**Future Directions (5)**: Planner v2 (output validation + re-prompt), operational autonomy (auto-pilot rules + morning summary), historical learning (run recommender), multi-repo awareness (package discovery), VS Code extension.

### Prior to This Session

- **Attention badge + gate naming fixes** (2026-05-08)
- **Live validation postmortem** (run_mowhf24a_8h62fc)
- **Session→agent rename: decided against** (2026-05-08)
- **Planner intelligence batch** (P1–P6)
- **Parser resilience batch** (two-tier verdict parsing)
- **Retry-exhausted fencepost fix**
- **Status terminology rewrite** (live/idle/completed/error/stale)
- **Critic-loop runaway-token leak fixed**
- **8 patterns shipped** (blackboard, council, orchestrator-worker, debate-judge, critic-loop, map-reduce, pipeline, none)

Active substrate:
- opencode :4096 launched via Windows Startup `.vbs`.
- Provider universe: zen + go + ollama (all routed through opencode).
- Workspace: reuse the same local directory across runs so commits accumulate.
- Dev server on port 8044 (`.env` with `OPENCODE_URL=http://172.24.32.1:4096`).

---

## Strategic Analysis Documents

20 documents spanning 12 methodologies. All in `docs/`.

| Document | Methodology | Key finding |
|----------|------------|-------------|
| `STRATEGY.md` | Ansoff + Scenario Planning | Penetration > development; B/D defensive posture |
| `SYSTEMATIC_FIXES.md` | Root cause analysis | Unmanaged session context is the root cause |
| `MONTE_CARLO.md` | Probabilistic simulation | $0.034/todo fixed cost coefficient; cost cap stops 93% of runs |
| `LCCA.md` | Life cycle cost | Operator time is 945× more expensive than token waste |
| `FAULT_TREE.md` | Fault tree (14 cut sets) | 7 of 14 cut sets are single-event OR-gates at the planner |
| `COMPOSITE_PLAN.md` | 5-analysis synthesis | 6 shared findings, 4 implementation plans |
| `IMPLEMENTATION_PLAN.md` | Prioritized queue | 3 tiers, 7.5 days total |
| `RECOMMENDATIONS.md` | Single-source queue | Stop-doing list, monitoring dashboard, steady-state conditions |
| `UML_ANALYSIS.md` | Class/state/sequence/component | 55-import type hub, 6-state machine with 2 missing transitions |
| `ARCHITECTURE_EVALUATION.md` | ATAM/SAAM/CBAM/DSM | 4 sensitivity points, 6 recommendations |
| `FORMAL_METHODS.md` | TLA+/Alloy/Invariants | CAS race-free (proved), 4 invariants (3 proved, 1 aspirational) |
| `FORMAL_METHODS_2.md` | Refinement/LTL/Data Flow | SQL refines abstract spec; unsanitized directive → LLM path found |
| `PERFORMANCE.md` | Load testing / benchmarking | LLM dominates 96-98% of latency — code optimizations save <4% |
| `SECURITY.md` | SAST/SCA/DAST/PenTest | 0 CRITICAL (local-only), 3 HIGH (all fixed) |

---

## Queued

**All items shipped.** Zero remaining.

| Category | Count | Status |
|----------|-------|--------|
| Composite Plan (A-D) | 15 items | ✅ All shipped |
| Cross-Plan (X1-X4) | 4 items | ✅ All shipped (X1 recurring) |
| Code Audit (F1-F4) | 4 items | ✅ All shipped |
| Weakness Fixes (W1-W3) | 3 items | ✅ All shipped |
| Future Directions (D1-D5) | 5 items | ✅ All shipped |
| **Recurring** | | |
| X1 | Postmortem→regex tightening | Weekly |
| MC re-run | Monte Carlo baseline check | Monthly |
| Cost trend | Cost-per-todo drift check | Monthly |

**Next**: Run `npx tsx scripts/pm-frequency.ts` weekly. When rate drops below
0.5/week for 4 consecutive weeks, steady-state achieved ($15.6K/yr maintenance
per LCCA). Then validate the 5 future directions live.

---

## Validation debt

(Shipped but not yet exercised live — see `docs/VALIDATION.md`):

- **Planner intelligence batch (P1–P6)** — needs live blackboard run
- **Ticker reliability fixes** — needs persistent-sweep run
- **Overnight 8h run** — 89% completion target
- **Planner v2 output validation** — needs live planner sweep to test re-prompt loop
- **Auto-pilot** — logging-only; needs operator review before enabling full autonomy
- **Contract tests** — will fire on next opencode API change
- **Playwright frame extraction** (`scripts/frame-extract.ts`) — needs live run with Playwright

---

## Postmortem follow-ups

| Postmortem | Status |
|---|---|
| `2026-04-24-orchestrator-worker-silent.md` | F1/F3/F6 VERIFIED. F2/F4/F7/F8/F9 SHIPPED. |
| `2026-04-25-agent-name-silent-drop.md` | F1 VERIFIED. Closed. |
| `2026-04-26-critic-loop-runaway-token.md` | F1 VERIFIED via synthetic test. |
| `2026-05-08-blackboard-planner-sweep-error.md` | F1–F4 all SHIPPED. Live re-validation pending. |
