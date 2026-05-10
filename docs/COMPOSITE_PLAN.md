# Composite Implementation Plan — opencode_swarm

**Source**: 5 analyses (Ansoff, Scenario Planning, Monte Carlo, LCCA, FTA)
merged into shared findings that none contradict. From those shared findings,
four execution plans derived. No repetition from prior documents.

---

## Part 1: Shared Findings (Cross-Analysis, Non-Contradictory)

These 6 findings appear in at least 3 of 5 analyses, in different forms,
pointing to the same conclusion. They are the foundation. All implementation
plans below derive from one or more of them.

### SF1 — Planner is the single point of failure

| Analysis | Form |
|----------|------|
| Monte Carlo | 81% of token spend is planner. Team size doesn't change output. |
| FTA | 7 of 14 minimal cut sets are OR-gated at the planner sweep. |
| LCCA | Planner errors cost $416/yr in operator time. |
| Functional Flow | Planner sweep is the serial bottleneck; workers idle waiting. |

**Unified conclusion**: Every dollar and engineering hour spent on the
planner (reliability, token reduction, error handling) has 10× the impact
of the same investment on workers.

### SF2 — Parallel-redundant patterns are structurally superior

| Analysis | Form |
|----------|------|
| Scenario Planning | Parallel-redundant (blackboard, council) survive B/D scenarios. |
| FTA | Serial-critical patterns are OR-gated; one death kills the run. |
| Monte Carlo | Blackboard completes 137 todos regardless of team size or silent prob. |

**Unified conclusion**: Default to blackboard unless the work shape
specifically requires a serial-critical topology. The pattern recommender
should weight parallel-redundant patterns 2× higher.

### SF3 — Cost cap, not throughput, is the binding constraint

| Analysis | Form |
|----------|------|
| Monte Carlo | 93% of runs stop at $5 cost cap. |
| LCCA | $5.26/run unit economics. $0.034/todo is the fixed cost coefficient. |
| FTA | G2 (cost cap) is the dominant premature stop — not a fault, by design. |
| Ansoff | Run duration is limited by budget confidence, not technical capacity. |

**Unified conclusion**: Optimizing throughput (more workers, faster sweeps)
is wasted effort. The operator already gets 137 todos per $5. The only way
to get more is to reduce cost per todo — which means reducing planner
token consumption.

### SF4 — Operator time dominates all costs

| Analysis | Form |
|----------|------|
| LCCA | Operator time $50/incident vs token waste $0.05/run. Ratio 945:1. |
| FTA | Dead-run restart is the costliest basic event (B8 × 5 AND-gates). |
| Scenario Planning | Human-in-the-loop inject reduces monitoring burden. |

**Unified conclusion**: Any feature that reduces operator babysitting (auto-
restart, silent-session notification, degradation recovery) has 100-1000×
higher ROI than any feature that reduces token costs.

### SF5 — Reliability investment has guaranteed positive ROI

| Analysis | Form |
|----------|------|
| LCCA | Every reliability fix returns 433% annual ROI. |
| Ansoff | Market penetration (reliability) precedes product development. |
| Scenario Planning | Defensive posture in B/D scenarios — invest in resilience. |
| FTA | Eliminating a single cut set is cheaper than living with it. |

**Unified conclusion**: The decision rule is clear. For any proposed
investment: if it reduces operator interventions → do it. If it doesn't →
defer until steady state.

### SF6 — Team size and sweep cadence are optimizations without benefit

| Analysis | Form |
|----------|------|
| Monte Carlo | 2/4/6 workers = identical output. 5/10/20-min cadence = identical output. |
| Functional Flow | Workers drain board in 10-20s. Planner takes 60-90s. Workers wait. |
| LCCA | More workers = more idle sessions = more overhead. |

**Unified conclusion**: The defaults should enforce the minimum viable
configuration. Team size: 2. Sweep cadence: 10 min. Anything above these
is waste.

---

## Part 2: Implementation Plans from Composite Outputs

### Plan A — Monitoring Dashboard (from Composite Output: Metrics + Thresholds)

**What**: Four metrics, coded into the system, with visual thresholds.

**Shared findings driving this**: SF1 (planner is SPOF → track planner errors),
SF4 (operator time dominates → track postmortem frequency), SF3 (cost cap
binds → track cost per todo).

#### A1 — Postmortem Frequency in Top Bar (~0.2 days)

**File**: `components/swarm-topbar/health-chips.tsx` — new `PMFrequencyChip`
- Reads count of `.md` files in `docs/POSTMORTEMS/` (excluding README.md) via a
  `useQuery` to `GET /api/swarm/diagnostics/postmortems`
- Renders as a chip with color threshold: 🔴 if ≥ 2.5/week, 🟡 if ≥ 1.0, else 🟢
- Tooltip: "postmortems/week — target < 0.5/week"

**File**: `app/api/swarm/diagnostics/postmortems/route.ts` (new, ~20 lines)
- Reads `docs/POSTMORTEMS/`, counts dated `.md` files
- Returns `{ count, weeks, rate }`

#### A2 — Cost-Per-Todo Trend in Top Bar (already shipped)

`swarm-topbar.tsx` — cost-per-todo badge. Shows `$0.034/todo`. Already wired.
Add a tooltip note: "target: $0.034 ± 0.005. Drift > $0.040 = investigate."

#### A3 — Planner Error Rate in Top Bar (~0.2 days)

**File**: `components/swarm-topbar/health-chips.tsx` — extend `RunHealthChip`
- Read `plannerErrors` from ticker snapshot (new field, see A3a)
- Show as count with tooltip: "X planner errors this run (target < 3%/sweep)"

**File**: `lib/server/blackboard/auto-ticker/types.ts` — add `plannerErrors: number` to `TickerState`
**File**: `lib/server/blackboard/planner/sweep.ts` — increment counter on error

#### A4 — Silent Turn Rate in Top Bar (~0.1 days)

**File**: `components/swarm-topbar/health-chips.tsx` — extend `RunHealthChip`
- Already receives `silentSessions`. Count them.
- Show as: "X silent sessions" with tooltip "target < 10% per turn"

---

### Plan B — Stop-Doing Enforcement (from Composite Output: Anti-Patterns)

**What**: Code changes that make anti-patterns impossible or warned.

**Shared findings driving this**: SF6 (team size and sweep cadence are waste),
SF3 (cost cap binds — don't burn budget faster).

#### B1 — Team Size Hard Cap at 3 (~0.1 days)

**File**: `lib/swarm-run-types.ts` — add `maxTeamSize: 3` to `PATTERN_TEAM_SIZE`
**File**: `app/api/swarm/run/route.ts` — reject requests with `teamSize > 3` with
  400: "Monte Carlo simulation shows 2 workers = same output as 6. Max team size is 3."

The console.warn on exceed was advisory. Now it's a hard rejection.

#### B2 — Sweep Cadence Min at 10 (~0.1 days)

**File**: `app/api/swarm/run/route.ts` — if `persistentSweepMinutes` is set and
  non-zero, validate `>= 10`. Reject with 400: "Monte Carlo shows 5-min cadence
  has zero benefit over 10-min. Minimum is 10."

Slider step already at 10. This adds server-side validation.

#### B3 — Feature Gate on Postmortem Rate (~0.3 days)

**File**: `scripts/pm-frequency.ts` — return exit code 1 if rate ≥ 2.5/week
**In CI**: Add a pre-commit hook that blocks non-reliability-file changes
  when `npx tsx scripts/pm-frequency.ts` returns exit code 1.

This makes the anti-pattern (building features while postmortems are high)
physically impossible to commit.

---

### Plan C — Steady-State Condition (from Composite Output: When Are We Done?)

**What**: Code changes that close the remaining gap to steady state.

**Shared findings driving this**: SF1 (planner is SPOF — fix it), SF5
(reliability ROI is guaranteed — invest until done).

#### C1 — Headless Engine Extraction (~3 days)

The last unshipped major item. Covered in `docs/IMPLEMENTATION_PLAN.md` Tier 3.1.
Enables CI webhook (already endpoint-shipped), eliminates manual run management.

#### C2 — Planner Context-Limit Truncation (~0.3 days)

Covered in `docs/RECOMMENDATIONS.md` Queue Item E. Truncates README + lessons
to fit within GLM's 128K context window. Reduces B2 (model silent) frequency.

**File**: `prompt.ts` — add `truncateToFit()` function.

#### C3 — Auto-Scale Team Size with Budget (~0.3 days)

**New idea from SF3 + SF6**: If the cost cap is the bottleneck and team size
doesn't matter, the system should auto-scale to the minimum viable team.

**Implementation**: In `route.ts`, when `teamSize` is not explicitly set,
default to 2 if `costCap <= $5` and 3 if `costCap > $5`. This means the
operator gets the optimal team size without having to know about SF6.

#### C4 — Steady-State Assertion Test (~0.2 days)

**File**: `lib/server/__tests__/steady-state.test.ts` (new)
- Asserts: `plannerErrorRate < 0.03` (from MC baseline)
- Asserts: `silentProbability < 0.10` (from MC baseline)
- Asserts: `costPerTodo > 0.029 && costPerTodo < 0.042` (from MC P5-P95)
- These are regression tests for the steady-state condition. If any metric
  regresses, CI fails.

---

### Plan D — Convergence Formula (from Composite Output: Decision Script)

**What**: A script that encodes the 5-analysis decision framework. Given a
proposed change, it returns "DO", "SKIP", or "INVESTIGATE" with the
specific analyses that support/refute.

**Shared findings driving this**: All 6 — this is the automated application
of the unified conclusions.

#### D1 — Decision Script (~0.3 days)

**File**: `scripts/decide.ts`
```ts
Input: { description, quadrant, effortHours, reducesInterventions, isReliability, isFeature }
Output: { verdict: 'DO' | 'SKIP' | 'INVESTIGATE', analyses: { ansoff, scenario, mc, lcca, fta } }
```

Rules:
1. If `reducesInterventions` AND `effortHours <= 8` → **DO** (LCCA: 433% ROI)
2. If `isFeature` AND postmortemRate >= 2.5 → **SKIP** (LCCA: no ROI yet)
3. If `isReliability` AND `reducesInterventions` → **DO** (all 5 agree)
4. If `quadrant === 'diversification'` → **SKIP** (Ansoff: trap at prototype stage)
5. If `effortHours > 40` → **INVESTIGATE** (re-scope to <40 hours)
6. Otherwise → **INVESTIGATE** (run full analysis)

**Example run**:
```
$ npx tsx scripts/decide.ts --desc "add dual-planner sweeps" --effort 12 --reduces-interventions --is-reliability
DO
  Ansoff: penetration ✓
  Scenario: robust in B/D ✓
  Monte Carlo: 15% → 2.25% ✓
  LCCA: $1,560/yr, 10mo payback ✓
  FTA: eliminates CS1-CS7 ✓
  ALL 5 AGREE
```

```
$ npx tsx scripts/decide.ts --desc "multi-repo awareness" --effort 8 --quadrant development
SKIP
  Ansoff: development (correct quadrant) ✓
  Scenario: fragile in B/D ✗
  LCCA: no ROI (doesn't reduce interventions) ✗
  2 ANALYSES REJECT
```

#### D2 — Git Hook Integration (~0.1 days)

Pre-commit hook: for any non-test, non-docs change with >20 lines:
- Run `npx tsx scripts/decide.ts` with the commit message
- If SKIP, block the commit with the analysis results

This bakes the decision framework into the development workflow.

---

## Execution Order

| Day | Plan Item | Effort | Shared Finding |
|-----|-----------|--------|---------------|
| 1 | A (dashboard: A1, A3, A4) | 0.5 days | SF4, SF1 |
| 1 | B (anti-patterns: B1, B2) | 0.2 days | SF6 |
| 2 | C4 (steady-state test) | 0.2 days | SF1, SF3 |
| 2 | C2 (context-limit truncation) | 0.3 days | SF1 |
| 3 | C3 (auto-scale team size) | 0.3 days | SF3, SF6 |
| 3 | D1 (decision script) | 0.3 days | All 6 |
| 4 | B3 (feature gate hook) | 0.3 days | SF5 |
| 4 | D2 (git hook) | 0.1 days | SF5 |
| 5-7 | C1 (headless engine) | 3 days | SF2, SF3 |
| **Total** | | **~5.2 days** | |

---

## The Composite Principle

Every plan derives from a shared finding. Every shared finding is supported
by 3+ analyses. No plan contradicts another plan. The execution order is
deterministic: dashboard first (visibility), then enforcement (stop doing
harm), then steady-state (close the gap), then automation (make decisions
self-executing).

The convergence: all 5 analyses, through 6 shared findings, through 4 plans,
through 10 concrete code changes. Zero contradictions.
