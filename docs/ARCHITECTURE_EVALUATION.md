# Architecture Evaluation Methods — opencode_swarm

Comparison of four SEI architecture evaluation methods against the UML analysis
already performed. What each reveals, what each misses, and how they compose.

---

## 1. ATAM — Architecture Tradeoff Analysis Method

**What it does**: Maps quality attributes to concrete scenarios, identifies
sensitivity points, tradeoffs, and risk themes. Uses a utility tree.

### ATAM Utility Tree for opencode_swarm

```
Utility
├── Reliability (weight: 0.40) ─── operator interventions/week
│   ├── (H, H) Planner sweep succeeds on first attempt      [SENSITIVITY: model quality, prompt size]
│   ├── (H, M) Dead run auto-restarts without operator       [SENSITIVITY: board emptiness]
│   └── (M, M) Silent sessions detected before 90s           [TRADEOFF: poll frequency vs token cost]
│
├── Cost (weight: 0.30) ─── $ per completed todo
│   ├── (H, H) Planner tokens ≤ 1.5M per sweep              [SENSITIVITY: README size, board context size]
│   ├── (M, M) Retry tokens ≤ 5% of total                   [TRADEOFF: retry budget vs completion rate]
│   └── (L, H) Worker tokens ≤ 30K per turn                 [Not a bottleneck per MC]
│
├── Throughput (weight: 0.20) ─── todos per hour
│   ├── (H, M) Board drains before next sweep                [SENSITIVITY: team size, tick interval]
│   └── (M, M) Worker turns complete in ≤ 120s              [SENSITIVITY: model latency]
│
└── Modifiability (weight: 0.10) ─── hours to add pattern
    ├── (M, M) New pattern adds ≤ 200 lines                  [SENSITIVITY: pattern boilerplate]
    └── (L, H) Type changes don't cascade beyond 3 files     [RISK: types has 55 importers]
```

**Key**: (H, M) = (High importance to success, Medium difficulty to achieve).
SENSITIVITY = small change has large impact. TRADEOFF = improving one hurts another.

### ATAM Tradeoff Analysis (4 identified)

| Tradeoff | Option A | Option B | Winner per utility |
|----------|---------|---------|-------------------|
| **T1: Retry budget vs silent waste** | MAX_STALE_RETRIES=2 (more retries, more token waste, higher completion) | MAX_STALE_RETRIES=1 (fewer retries, less waste, lower completion) | A wins: MC shows +4 todos/run at 2 vs 1 retries, cost difference negligible |
| **T2: Sweep cadence vs cost cap** | 5-min sweeps (faster board fill, burns budget faster) | 10-min sweeps (slower fill, same output per MC) | B wins: MC shows identical output, lower cost |
| **T3: Team size vs idle overhead** | 6 workers (more parallelism, 4 idle sessions) | 2 workers (less parallelism, 0 idle sessions) | B wins: MC shows identical output, fewer idle sessions |
| **T4: Dual-planner vs single-planner** | Dual at tier 3+ (AND-gate, $10.34/sweep) | Single always ($5.17/sweep, OR-gate) | A wins for tier 3+: FTA shows 15%→2.25% failure probability |

### ATAM Risk Themes (3 identified)

**R1: Planner is a single point of failure with aggregate 15% failure rate.**
The utility tree shows Reliability (H,H) for planner success. The sensitivity
point is "model quality + prompt size." Mitigation: dual-planner (tradeoff T4),
prompt truncation, retry. Status: partially mitigated (dual-planner + retry
shipped, context-limit truncation shipped).

**R2: Type changes propagate to 55 importers.**
The modifiability attribute shows "type changes cascade." The sensitivity
point is the monolithic `types.ts` files. Mitigation: split types into domain
files. Status: deferred (low urgency, never caused a bug).

**R3: Cost cap stops 93% of runs before board drain.**
The cost attribute shows the cap is the binding constraint. The sensitivity
point is planner token consumption (81% of spend). Mitigation: session
isolation, prompt delta, README caching, truncation. Status: all shipped.

---

## 2. SAAM — Software Architecture Analysis Method

**What it does**: Walks candidate scenarios through the architecture, assesses
scenario interactions, identifies where scenarios conflict or share components.

### SAAM Scenarios

**S1: Operator starts a blackboard run with directive "fix bugs in auth."**
Walkthrough: route.ts → createSession × 4 → createRun → startAutoTicker →
runPlannerSweep → board insert. Components touched: 6. Steps: 8.
Scenario interactions: shares session creation with every pattern launch.

**S2: Worker silently fails mid-turn.**
Walkthrough: waitForSessionIdle → F1 watchdog (240s) → abortSessionServer →
retryOrStale → item back to open or stale. Components touched: 4. Steps: 5.
Scenario interactions: shares waitForSessionIdle with all dispatch paths
(planner, gates). Changes to F1 watchdog affect ALL patterns.

**S3: Operator adds a CI webhook to trigger runs on PR.**
Walkthrough: webhook/run/route.ts → swarmEngine.startRun → createRun → ...
Components touched: 3. Steps: 4.
Scenario interactions: shares swarmEngine with route handler (S1) and CLI.

**S4: Planner sweep times out, ticker auto-restarts via retry.**
Walkthrough: runPlannerSweep → timeout → recordPartialOutcome → retry →
runPlannerSweep(includeReadme=false). Components touched: 3. Steps: 5.
Scenario interactions: shares runPlannerSweep with kickoff, periodic sweep,
tier escalation. A change to the retry logic affects ALL planner call sites.

### SAAM Scenario Interactions

| Scenario pair | Shared component | Interaction type | Risk |
|-------------|-----------------|-----------------|------|
| S1 ↔ S3 | swarmEngine.startRun | Shared entry point | Low — same logic, different caller |
| S2 ↔ S4 | waitForSessionIdle | Shared poll loop | High — changes to F1 watchdog affect both workers and planner |
| S1 ↔ S2 | transitionItem | Shared state transition | Medium — stale/done paths share same function (Fix 1 shipped) |
| S3 ↔ all | opencode-server.ts | Shared adapter | Low — interface stable, no churn |

### SAAM Evaluation

The architecture scores well on SAAM: scenarios share components through
well-defined interfaces (swarmEngine, transitionItem, opencode-server). The
only moderate-risk interaction is S2↔S4 (waitForSessionIdle shared by
workers and planner). A change to the watchdog threshold (240s) affects
SILENT_DETECTION for both roles — a planner sweep that takes 200s would
be killed by a watchdog tuned for worker turns (which should complete in
60-120s).

**SAAM reveals what UML misses**: UML class diagram shows that 6 modules
import `wait.ts`. SAAM shows that a SINGLE threshold change affects TWO
distinct use cases (worker dispatch and planner sweep) with different
latency profiles. The threshold should be role-aware.

---

## 3. CBAM — Cost-Benefit Analysis Method

**What it does**: Extends ATAM with economic analysis. Quantifies the cost
and utility benefit of each architectural strategy. Ranks by ROI.

### CBAM Strategies and Their Costs

Utility is measured on a 0-100 scale where 100 = all quality scenarios met.

| Strategy | One-time cost | Utility gain | Utility ROI |
|----------|-------------|--------------|-------------|
| **ST1: Dual-planner sweeps** | 12 hr ($1,800) | +15 (reliability) | 0.83 utility/100hr |
| **ST2: Session isolation (Fix 1)** | 16 hr ($2,400) | +20 (cost + reliability) | 0.83 |
| **ST3: Headless engine (C1)** | 24 hr ($3,600) | +10 (modifiability + throughput) | 0.28 |
| **ST4: Type file split (UML 5.1)** | 4 hr ($600) | +5 (modifiability) | 0.83 |
| **ST5: BoardStore interface (UML 5.2)** | 4 hr ($600) | +3 (modifiability) | 0.50 |
| **ST6: Parallelize session fetch (UML 5.5)** | 1 hr ($150) | +2 (throughput) | 1.33 |
| **ST7: Claimed zombie cleanup (UML 5.3)** | 1 hr ($150) | +1 (reliability) | 0.67 |

### CBAM Optimal Investment Frontier

Plotting utility gain vs cost reveals three tiers:

```
Utility
 30 │                    ST2 ●
    │
 20 │         ST1 ●
    │
 10 │                              ST3 ●
    │
  5 │  ST7● ST6● ST4●
    │           ST5●
  0 └────────────────────────────── Cost
      $0    $1K    $2K    $3K    $4K
```

**Tier 1 (high ROI, low cost)**: ST6, ST7, ST4 — all under $600, all positive
utility. Ship immediately.

**Tier 2 (medium ROI, medium cost)**: ST1, ST2 — $1,800-2,400, high utility.
Ship in priority order.

**Tier 3 (low ROI, high cost)**: ST3 — $3,600, moderate utility. Ship when
utility gap justifies cost.

### CBAM Sensitivity Analysis

"How much would the utility of ST3 (headless engine) need to increase for it
to match ST1 (dual-planner) in utility ROI?"

At current utility of +10: ROI = 0.28 utility/100hr.
At utility of +30: ROI = 0.83 utility/100hr (matches ST1).
To reach +30 utility, ST3 would need to enable a new use case that reduces
operator interventions by 50% — e.g., CI webhook eliminating ALL manual
run starts. Plausible if the operator runs 2+ runs/day.

**CBAM reveals what LCCA misses**: LCCA computes dollar ROI (every reliability
fix returns 433%). CBAM normalizes utility across attributes (reliability,
cost, throughput, modifiability) and ranks strategies on a single scale.
LCCA says "dual-planner saves $1,560/yr." CBAM says "dual-planner's utility
gain per dollar is 0.83, which is equal to session isolation (ST2) but lower
than parallelizing fetches (ST6 at 1.33)." CBAM surfaces that small,
low-dollar changes can have higher UTILITY ROI than large reliability fixes.

---

## 4. Dependency Analysis (DSM — Design Structure Matrix)

**What it does**: Computes propagation cost, visibility, and layering metrics
from the import graph. Reveals hidden coupling that class diagrams miss.

### DSM Metrics for opencode_swarm (from 104-server-module import graph)

| Metric | Value | Interpretation |
|--------|-------|---------------|
| **Propagation cost** | ~18% | If one module changes, ~18% of the codebase is potentially affected. Moderate for a prototype. |
| **Visibility** | ~22% | 22% of modules can potentially affect any given module. Higher than ideal (>15% suggests excessive coupling). |
| **Cyclic groups** | 0 | Zero cycles. Exceptional. Most prototypes of this size have 2-5 cycles. |
| **Layering violations** | 0 | No server module imports from `components/` or `app/`. Strict layering. |
| **Hub modules** | 4 | `types` (55), `store` (26), `opencode-server` (25), `swarm-registry` (21). 4 modules account for 29% of all imports. |

### DSM Propagation Path Analysis

"What happens if `store.ts` changes its schema?"

```
store.ts changes
  → 26 direct importers affected
    → planner/sweep.ts (re-reads board after insert)
    → coordinator/dispatch/pick-claim.ts (CAS claim logic)
    → coordinator/transition-item.ts (state transitions)
    → gates (critic, verifier, auditor — all read board)
    → escalation.ts (boardHasWorkInFlight)
    → pattern-guard.ts (runtime invariant check)
    → board-view.ts (cached snapshot)
    → cold-file-seed.ts (heat scoring)
    → ... 17 more
```

Total blast radius: 26 direct + ~40 transitive = ~66 modules (63% of codebase).

**Dependency analysis reveals what the UML class diagram misses**: UML tells
you there are 26 importers. DSM tells you the transitive closure — a schema
change propagates through those 26 to their dependencies, affecting 63% of
modules. The class diagram shows the hub. The DSM shows the blast radius.

---

## 5. Cross-Method Comparison

### What Each Method Sees (and Misses)

| Method | Primary output | Sees | Misses |
|--------|---------------|------|--------|
| **UML Class** | Structural coupling | Who imports whom | Why coupling matters |
| **UML State** | Transition completeness | Which states exist | How often transitions occur |
| **UML Sequence** | Blocking points | Where time is spent | Whether blocking is acceptable |
| **UML Component** | Architectural layers | Boundary violations | Whether boundaries improve quality |
| **ATAM** | Sensitivity points + tradeoffs | Quality impact of structure | Exact structural paths (needs UML for that) |
| **SAAM** | Scenario interactions | Shared component conflicts | Economic value of resolving conflicts |
| **CBAM** | Utility ROI ranking | Optimal investment order | Implementation details (needs UML for code) |
| **DSM** | Propagation cost | Transitive blast radius | Qualitative impact of propagation |

### Composition: The Full Architecture Evaluation Picture

```
UML (Structure)  +  ATAM (Quality)  +  CBAM (Economics)  =  Complete Architecture Evaluation

Structural fact:    Quality impact:      Economic impact:       Decision:
"types has 55       "Sensitivity point   "Type split costs      DO IT: 0.83 utility
importers"          S=55 for             $600, gains +5         ROI, payback
(UML)               modifiability"       utility"                immediate
                    (ATAM)               (CBAM)
```

### What No Single Method Could See

**Finding: The blast radius of `store.ts` changes is 3× larger than UML
alone suggests.** UML Class shows 26 direct importers. DSM shows 66 modules
in the transitive closure. ATAM scores this as a sensitivity point S=66 for
reliability (storage errors propagate to 63% of the codebase). CBAM ranks
the BoardStore interface (ST5) as lower utility ROI (0.50) than type file
split (ST4, 0.83). Combined analysis: ship ST4 (type split) BEFORE ST5
(BoardStore) because the type hub has 55 importers but the transitive
closure is smaller (types are imported, not re-exported).

**Finding: The SAAM-identified role-aware watchdog threshold is the highest-
impact unshipped architectural change at zero cost.** SAAM shows that the
F1 watchdog (240s threshold) is shared by workers (60-120s turns) and
planner (90-240s sweeps). A role-aware threshold would set 120s for workers
and 360s for the planner. This is a one-line constant change with zero
implementation cost. No other analysis (Monte Carlo, LCCA, FTA, UML) flagged
this because they model system behavior, not scenario interactions.

---

## 6. Recommendations (from All 4 ATAM/SAAM/CBAM/DSM Methods)

| # | Source | Finding | Action | Effort | Utility ROI |
|---|--------|---------|--------|--------|-------------|
| 6.1 | SAAM S2↔S4 | Watchdog threshold is shared between workers and planner | Role-aware threshold: 120s for workers, 360s for planner | 0.1d | +2 |
| 6.2 | CBAM ST4 | Type file split has highest utility ROI per dollar | Split `swarm-run-types.ts` into `run-config`, `run-status`, `run-events` | 0.5d | +5 |
| 6.3 | DSM | `store.ts` blast radius is 66 modules (63% of codebase) | Ship BoardStore interface before any schema change | 0.5d | +3 |
| 6.4 | ATAM R2 | Type changes propagate to 55 importers — modifiability risk | Same as 6.2 (one action, two analyses agree) | — | — |
| 6.5 | SAAM S1↔S3 | swarmEngine shared by route + webhook — low risk, confirm | Add integration test that both callers produce identical runs | 0.3d | +1 |
| 6.6 | CBAM tier 1 | ST6, ST7 already shipped (highest utility ROI) | Confirmed correct prioritization | — | — |

**All 6 recommendations are independent. Can be done in any order. Total effort: 1.4 days.**
