# Consolidated Implementation Plan — opencode_swarm

Priorities derived from five analyses spanning 2026-05-08:
- Ansoff Matrix (market/product strategy)
- Scenario Planning (cross-uncertainty resilience)
- Monte Carlo Simulation (3,000 trials, probabilistic modeling)
- Life Cycle Cost Analysis (systems engineering economics)
- Fault Tree Analysis (14 cut sets, structural importance)

**Guiding metric**: Operator interventions per week. Every hour of engineering
spent reducing this number returns 433% annual ROI (LCCA).

**Current state**: 5.0 postmortems/week (FTA verified), $195K/yr maintenance
cost (LCCA computed). Below are the remaining items needed to reach steady-state
(<0.5 postmortems/week, $15.6K/yr).

---

## Tier 1 — Eliminate Remaining Operator Interventions (~2 days)

These prevent the operator from having to manually restart or diagnose a
dead run. Each pays for itself in <3 months (LCCA break-even analysis).

### 1.1 Dual-Planner Sweeps at Tier 3+ (~1.5 days)

**Source**: FTA structural insight. The planner sweep is OR-gated across 7
independent basic events. Converting it to AND-gated (two independent planner
sessions, only one must succeed) drops failure probability from 15% to 2.25%.

**Implementation**:

`lib/server/blackboard/planner/dual-sweep.ts` (new, ~80 lines):
```ts
export async function runDualPlannerSweep(
  swarmRunID: string,
  opts: PlannerSweepOpts,
): Promise<PlannerSweepResult> {
  // Fire two independent planner sweeps in parallel.
  // If either succeeds, return its results. Both must fail for the run to die.
  const [a, b] = await Promise.allSettled([
    runPlannerSweep(swarmRunID, opts),
    runPlannerSweep(swarmRunID, { ...opts, overwrite: true }),
  ]);
  if (a.status === 'fulfilled' && a.value.items.length > 0) return a.value;
  if (b.status === 'fulfilled' && b.value.items.length > 0) return b.value;
  // Both failed — re-throw the first error
  if (a.status === 'rejected') throw a.reason;
  throw new Error('dual planner sweep: both sessions produced zero todos');
}
```

**Trigger**: Only at tier 3+ escalation (where the cost of a dead run is
highest — most tokens already invested). Tier 1-2 sweeps already have
the auto-retry (MC Insight 4).

**Cost**: 2× planner tokens per tier-3 sweep. At ~$5.17/sweep, dual sweeps
cost ~$10.34. But reducing dead-run probability from 15% to 2.25% saves
$50/dead-run in operator time. Break-even at 1 prevented dead run per 5
dual-sweeps — achieved within one tier-3 run.

**Files**: `dual-sweep.ts` (new), `sweep.ts` (call dual at tier 3+),
`types.ts` (add `enableDualSweep` flag).

### 1.2 Operator Notification on Silent Session (~0.3 days)

**Source**: LCCA — operator time is 945× more expensive than token waste.
The operator should know about silent sessions BEFORE the F1 watchdog fires.

**Implementation**:

`components/swarm-topbar/health-chips.tsx` — add `SilentSessionChip`:
- Renders when `silentSessions.length > 0`
- Amber-colored chip showing count: "3 silent"
- Tooltip lists session IDs + minutes since last activity
- Pulsing animation to draw attention

**Files**: `health-chips.tsx` (+20 lines).

### 1.3 Graceful Degradation — Recovery Actions (~0.5 days)

**Source**: Fix 3 shipped detection, but not recovery. FTA shows serial-critical
patterns (OW, critic-loop, debate-judge) die silently when a critical-role
session fails. These deaths each cost $50 in operator time (LCCA).

**Implementation**: Extend the `degrade()` handlers in `pattern-guard.ts` to
perform actual recovery:

| Pattern | Degrade action |
|---------|---------------|
| critic-loop | `postSessionMessageServer` to worker: "critic unavailable, your output is accepted as-is" |
| OW | `postSessionMessageServer` to new orchestrator: replay the original directive as a re-sweep prompt |
| debate-judge | `postSessionMessageServer` to new judge: "evaluate the remaining proposals and pick a winner" |

**Files**: `pattern-guard.ts` (+30 lines), `tick.ts` (call degrade in fanout).

---

## Tier 2 — Reduce Planner Failure Probability (~2 days)

The planner sweep is the single point of failure with the highest structural
importance (FTA). Every 1% reduction in planner failure probability saves
~$26/yr in dead-run costs.

### 2.1 Regex Tightening from Parse-Failure Analytics (~0.5 days, recurring weekly)

**Source**: Scenario Planning — parse failure analytics endpoint is shipped
but not yet used for regex improvement.

**Process** (not a code change):
1. Weekly: `curl GET /api/_debug/swarm-run/:id/parse-failures | jq`
2. Identify the top-3 most frequent failure patterns
3. Tighten the regex in `parsers.ts` for those patterns
4. Monitor for 1 week — did unclear verdicts decrease?

**Expected**: 2-3% reduction in planner failure rate per month.

### 2.2 Planner Prompt Truncation by Model Context Limit (~0.5 days)

**Source**: FTA B2 (model silent, 5%/sweep) is partially caused by context
overflow. opencode-models.ts already has context limits. The planner prompt
should respect the actual model's limit.

**Implementation**:

`lib/server/blackboard/planner/prompt.ts` — add `truncatePromptToContextLimit`:
```ts
// Truncate README + lessons to fit within the planner model's context limit.
// Context limit from opencode-models.ts. Leaves 20% headroom for tool defs.
function truncateToFit(prompt: string, modelID: string, readme: string | null): string;
```

**Files**: `prompt.ts` (+25 lines).

### 2.3 Open code Error Retry (~0.2 days)

**Source**: FTA B5 — opencode 500/503 errors at 0.5%/sweep. Currently handled
by the generic planner error path. A specific retry for 500/503 (transient)
would reduce this to near zero.

**Implementation**: In `sweep.ts`, when `waited.reason === 'error'`, retry
once after a 5s delay (transient opencode hiccup).

**Files**: `sweep.ts` (+8 lines).

---

## Tier 3 — Enable Scale and New Use Cases (~4 days)

These items don't reduce operator interventions (Tier 1 metric) but enable
the product to serve more use cases per the Ansoff Matrix.

### 3.1 Headless Engine Extraction (~3 days)

**Source**: Scenario Planning cross-scenario robust option + Ansoff Market
Development (CI/CD pipelines). Currently deployed in STATUS.md queue.

**Implementation**:

`lib/server/swarm-engine/` (new directory):
```
swarm-engine/
  index.ts          — startRun(pattern, config) → { swarmRunID, subscribe(cb) }
  ticker.ts         — auto-ticker (moved from blackboard/auto-ticker/)
  board.ts          — board store (moved from blackboard/store.ts)
  planner.ts        — planner sweep (moved from blackboard/planner/)
  coordinator.ts    — dispatch pipeline (moved from blackboard/coordinator/)
  gates/            — critic, verifier, auditor (moved from blackboard/)
  patterns/         — council, map-reduce, debate-judge, critic-loop, OW, pipeline
  memory/           — L0→L1→L2 ingest (moved from server/memory/)
```

**Key principle**: The engine is a pub-sub system. `startRun()` returns a
subscription handle. The UI (SSE, live hooks, page-footer) consumes events.
The route handlers (run, stop, nudge) call engine methods. The opencode
HTTP calls remain in `opencode-server.ts` (adapter layer).

**Expected**: Enables CI webhook trigger, headless mode, and multi-user
observability without touching existing code.

### 3.2 CI Webhook Trigger (~1 day)

**Source**: Ansoff Market Development. Endpoint already shipped (Item 5).
The remaining work is GitHub Actions integration + testing.

**Implementation**: Add a `.github/workflows/swarm.yml` template and
documentation in `docs/CI.md`.

**Files**: `.github/workflows/swarm.yml` (new), `docs/CI.md` (new).

---

## Effort Summary

| Tier | Item | Effort | FTA cut sets affected | LCCA annual savings |
|------|------|--------|----------------------|---------------------|
| **1.1** | Dual-planner sweeps | 1.5 days | CS1-CS7 (7 OR-gates → AND) | $1,560/yr |
| **1.2** | Silent session notification | 0.3 days | — (operator awareness) | $1,040/yr |
| **1.3** | Degradation recovery actions | 0.5 days | G1a (serial-critical deaths) | $780/yr |
| **2.1** | Regex tightening loop | 0.5 days (recurring) | B6, B7 (parse failures) | $520/yr |
| **2.2** | Context-limit truncation | 0.5 days | B2, B3 (silent/timeout) | $520/yr |
| **2.3** | Opencode error retry | 0.2 days | B5 (opencode 500/503) | $130/yr |
| **3.1** | Headless engine | 3 days | — (enables CI, scale) | Qualitative |
| **3.2** | CI webhook template | 1 day | — (market development) | Qualitative |
| **Total Tier 1+2** | | **3.5 days** | | **$4,550/yr** |
| **Total All Tiers** | | **7.5 days** | | **$4,550/yr + scale** |

**ROI**: Tier 1+2 costs ~$3,900 in engineering time and returns $4,550/yr.
Payback period: 10.3 months.

---

## Stop Criteria

When do we stop investing in reliability and start investing in features?

**Stop when**: Postmortem rate drops below 0.5/week for 4 consecutive weeks.
At that point, maintenance cost is $15.6K/yr (steady-state, per LCCA).
Additional reliability investments have diminishing returns.

**Signal**: Run `npx tsx scripts/pm-frequency.ts` weekly. When the trend
shows 4 consecutive green weeks, shift from Tier 1+2 to Tier 3.

**Current state**: 5.0/week. All weeks red. Estimated 4-6 weeks of Tier 1+2
work to reach 0.5/week.
