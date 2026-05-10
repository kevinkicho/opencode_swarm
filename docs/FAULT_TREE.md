# Fault Tree Analysis (FTA) — opencode_swarm

Top event: "Run produces zero output." This is the costliest failure —
$416/yr in operator time (LCCA) and $5/run in wasted tokens (MC simulation).

---

## 1. Fault Tree — Run Produces Zero Output

```
TOP: Run produces zero output
│
├──[OR]── G1: Planner never produces work
│   │
│   ├──[OR]── G1a: Planner sweep fails
│   │   │
│   │   ├── B1: Provider unreachable
│   │   │   └── ollama daemon down / network partition
│   │   │       Probability: ~3% per sweep (postmortem frequency)
│   │   │
│   │   ├── B2: Model silent (no output generated)
│   │   │   └── LLM accepts prompt, never produces assistant turn
│   │   │       Probability: ~5% per sweep (GLM-5.1 observed rate)
│   │   │
│   │   ├── B3: Model times out (> 15 min)
│   │   │   └── Slow provider or context overflow
│   │   │       Probability: ~2% per sweep (ollama-cloud latency spikes)
│   │   │
│   │   ├── B4: Model tool-loops (stuck retrying broken tool call)
│   │   │   └── GEMMA fixates on edit with bad oldString
│   │   │       Probability: ~1% per sweep
│   │   │
│   │   └── B5: Opencode error (500/503)
│   │       └── opencode daemon crash or internal error
│   │           Probability: ~0.5% per sweep
│   │
│   ├──[OR]── G1b: Planner produces zero todos
│   │   │
│   │   ├── B6: Model calls todowrite with empty list
│   │   │   Probability: ~2% per sweep (observed in postmortems)
│   │   │
│   │   └── B7: All proposed todos filtered
│   │       └── Dedup guard + vague criteria filter drops everything
│   │           Probability: ~1% per sweep
│   │
│   └──[AND]── G1c: Planner errors + board is empty
│       │
│       ├── G1a: Planner sweep fails (see above)
│       └── B8: Board has zero salvageable items
│           └── First sweep of a run OR previous sweep drained everything
│               Probability: ~15% of sweeps (board state dependent)
│
└──[OR]── G2: Auto-ticker never starts / stops prematurely
    │
    ├── B9: Session creation fails (opencode down at kickoff)
    │   Probability: ~0.2%
    │
    ├── B10: Run creation fails (route handler error)
    │   Probability: ~0.1%
    │
    └── G2a: Ticker stops due to no-claimable-work
        │
        ├── B11: All open todos are retry-exhausted
        │   └── Every open item has retry count >= maxRetries
        │       Probability: ~2% per tick cycle
        │
        └── B12: Board drained + planner produces nothing
            └── G1 already covers this
```

## 2. Cut Set Analysis

### 2.1 Minimal Cut Sets for "Run produces zero output"

A cut set is a set of basic events whose simultaneous occurrence causes the
top event. A MINIMAL cut set contains no subset that also causes the top
event.

```
CS1: { B1 }                         — provider unreachable kills sweep
CS2: { B2 }                         — model silent kills sweep
CS3: { B3 }                         — model timeout kills sweep
CS4: { B4 }                         — tool-loop kills sweep
CS5: { B5 }                         — opencode error kills sweep
CS6: { B6 }                         — empty todowrite
CS7: { B7 }                         — all todos filtered
CS8: { B1, B8 }                     — provider down + empty board
CS9: { B2, B8 }                     — model silent + empty board
CS10: { B3, B8 }                    — timeout + empty board
CS11: { B4, B8 }                    — tool-loop + empty board
CS12: { B5, B8 }                    — opencode error + empty board
CS13: { B9 }                        — session creation fails
CS14: { B10 }                       — run creation fails
```

**Key finding**: 7 out of 14 minimal cut sets are single-event (CS1–CS7).
This means **the run can be killed by any ONE of seven independent basic
events**. The system is fundamentally OR-gated at the top level.

CS8–CS12 are AND-gated (two events must coincide). These are rarer because
both events must occur. CS8 is the most critical AND-gate because B8
("board has zero salvageable items") is the condition that turns a
recoverable planner error into a fatal one.

### 2.2 Probability Computation

Using MC simulation data + postmortem frequency:

| Cut set | P(per sweep) | Mechanism | Fix shipped? |
|---------|-------------|-----------|-------------|
| CS1 (provider down) | ~3.0% | OR gate | F4: probeOllamaPs detects early |
| CS2 (model silent) | ~5.0% | OR gate | F1: watchdog aborts at 240s |
| CS3 (timeout) | ~2.0% | OR gate | Fix 1: session isolation reduces prompt size |
| CS4 (tool-loop) | ~1.0% | OR gate | F1: watchdog detects + aborts |
| CS5 (opencode error) | ~0.5% | OR gate | Not mitigated |
| CS6 (empty todowrite) | ~2.0% | OR gate | #99: finding recorded, zero-todo summary |
| CS7 (all filtered) | ~1.0% | OR gate | P2: improved dedup, filler-word stripping |
| CS8 (provider + empty) | 3.0% × 15% = 0.45% | AND gate | MC Insight 4: auto-retry |
| CS9 (silent + empty) | 5.0% × 15% = 0.75% | AND gate | MC Insight 4: auto-retry |

**Total P(top event per sweep)** = union of CS1–CS7 + CS8–CS12

Using inclusion-exclusion with independent events:
- P(any single-event CS fires) ≈ 1 - (1-0.03)(1-0.05)(1-0.02)(1-0.01)(1-0.005)(1-0.02)(1-0.01) ≈ 1 - 0.865 ≈ **13.5% per sweep**
- P(any AND-gated CS fires given CS1-7 didn't) ≈ ~2%
- **Total ≈ 15% per sweep**

This means: **across 23 sweeps in a run, the probability of at least one fatal
event is 1 - (1-0.15)^23 ≈ 98%**. The MC simulation said 93% of runs stop
at cost cap, and 7-10% die from planner error. The fault tree confirms:
almost every run encounters at least one sweep failure, but most are
recovered by retry + fallback mechanisms. The 7-10% that die are the ones
where the failure coincides with an empty board (B8).

### 2.3 Structural Importance

Which basic events are structurally the most important?

| Event | Probability | Structural importance | Cut sets containing it |
|-------|------------|----------------------|----------------------|
| **B8 (board empty)** | 15% | **Highest** — appears in 5 AND-gate cut sets | CS8–CS12 |
| B2 (model silent) | 5% | High — single-event AND AND-gate | CS2, CS9 |
| B1 (provider down) | 3% | High | CS1, CS8 |
| B6 (empty todowrite) | 2% | Medium | CS6 |
| B3 (timeout) | 2% | Medium | CS3, CS10 |
| B4 (tool-loop) | 1% | Low | CS4, CS11 |
| B7 (all filtered) | 1% | Low | CS7 |
| B5 (opencode error) | 0.5% | Low | CS5, CS12 |

**B8 (board empty) is the structural kingpin.** It's the condition that
converts 5 independent but recoverable failure modes into fatal ones. If
the board always has at least one salvageable item after a planner error,
the F1 fallback prevents the run from dying regardless of which basic
event fires.

---

## 3. Fault Tree — Run Stops Prematurely (Partial Output)

```
TOP: Run stops before board is truly drained
│
├──[OR]── G1: Ticker auto-stops
│   │
│   ├── G1a: auto-idle-drained
│   │   └── All sessions idle + boardHasWorkInFlight() = false
│   │       └── F2 fix: criteria now count as work in flight. Shipped.
│   │
│   └── G1b: no-claimable-work
│       └── consecutiveNoClaimableWork >= 18 ticks + no work in flight
│           └── Triggered when all open items are retry-exhausted zombies
│
├──[OR]── G2: Cost cap hit
│   │
│   ├── B13: Run exceeds $5 cost cap
│   │   └── 93% of runs (MC simulation). Normal behavior, not a fault.
│   │
│   └── G2a: Budget burned on non-productive work
│       │
│       ├── B14: Planner re-reads same context every sweep
│       │   └── Fix 1 + prompt delta shipped. Down from ~2.5M to ~1.5M/sweep.
│       │
│       └── B15: Retry loops burning tokens
│           └── Model-aware retry budgets shipped. GEMMA gets 1 retry.
│
└──[OR]── G3: Hard-cap enforced
    │
    ├── B16: Wall-clock cap (60 min)
    ├── B17: Commit cap (200 commits)
    └── B18: Todo cap (300 todos)
```

**Finding**: G2 (cost cap) is the dominant premature stop at 93%. This is
by design — the budget is the ceiling. The fault tree doesn't reveal a
bug here; it confirms the MC simulation finding that cost is the binding
constraint.

---

## 4. Fault Tree — Worker Produces No Useful Output

```
TOP: Worker turn produces no durable artifact
│
├──[OR]── G1: Turn went silent
│   │
│   ├── B19: Provider unreachable for this session
│   │   └── F4 probe detects, returns provider-unavailable
│   │
│   └── B20: Model produces no assistant turn (prompt accepted, no output)
│       └── GEMMA known failure mode: accepts prompt_async, never responds
│           Probability: ~10-25% per turn (silent probability in MC)
│
├──[OR]── G2: Turn produced text but no tool calls (pseudo-tool-text)
│   │
│   └── B21: Model emits `<tool>...</tool>` as plain text, not real tool calls
│       └── GEMMA on long-context prompts. Q34 root cause documented.
│           Fix: gateTurnsForSilentSessions detects + retries
│
├──[OR]── G3: Gate rejected the output
│   │
│   ├── G3a: Critic gate — BUSYWORK verdict
│   │   └── ~4% per todo claim
│   │
│   ├── G3b: Verifier gate — Playwright assertion failed
│   │   └── ~2% for verifier-enabled todos
│   │
│   └── G3c: CAS drift — files changed under the worker
│       └── ~3% for multi-worker runs on shared files
│           Fix: FileLockSet (Fix 2) addresses the root cause
│
└──[OR]── G4: Error during turn execution
    │
    ├── B22: Tool error (bash fails, read on missing file, etc.)
    │   └── Normal — retry handles this
    │
    └── B23: Session aborted mid-turn
        └── Operator hard-stop or shutdown hook
```

**Key finding**: The worker failure tree has 4 OR-gated branches. B20
(model silent) dominates at 10-25%. The retry budget absorbs most of
these, converting them from fatal to merely wasteful. The MC simulation
shows only 4 fewer todos per run at 25% silent vs 10%.

---

## 5. Mitigation Priority Matrix

Derived directly from cut set analysis. Priority = probability × structural importance × cost to fix.

| Priority | Target | Fix | Cut sets affected | Effort |
|----------|--------|-----|-------------------|--------|
| **P0** | B8 (board empty) | Auto-resume on planner error | CS8–CS12 (5 AND-gates) | Shipped (MC Insight 4) |
| **P0** | B1 (provider down) | Provider health probing | CS1, CS8 | Shipped (F4) |
| **P1** | B2 (model silent) | Session isolation (smaller prompts) | CS2, CS9 | Shipped (Fix 1) |
| **P1** | G1a (auto-idle) | Criteria count as work in flight | G1a | Shipped (F2) |
| **P2** | B7 (all filtered) | Improved dedup + filler-word stripping | CS7 | Shipped (P2) |
| **P2** | B21 (pseudo-tool-text) | Gate-checks detect zero real tools | G2 | Shipped |
| **P3** | B5 (opencode error) | Retry + graceful degradation | CS5, CS12 | ~0.5 days |
| **P3** | B9 (session creation fails) | Retry at kickoff | CS13 | ~0.2 days |
| **P4** | B15 (retry loops) | Model-aware retry budgets | G2a | Shipped (P6) |

---

## 6. Structural Insight: The OR-Gate Dominance Problem

The fault tree reveals a fundamental architecture issue: **the top event is
OR-gated across 7 independent basic events.** This means:

1. **No single fix can reduce the failure rate below ~2% per sweep.**
   Even if you eliminate the top 6 basic events, the 7th (say, B5: opencode
   error at 0.5%) still has an OR path to the top.

2. **The system is only as reliable as its least-reliable component.**
   Improvements to B2 (model silent) don't help if B1 (provider down) is
   the bottleneck. Defense-in-depth requires parallel improvements.

3. **AND-gating failures through redundancy is the only way to achieve
   high reliability.** If each sweep runs on two independent planner
   sessions (council-style redundancy), the failure rate drops from P
   to P². At P=15%, P²=2.25%.

This suggests a strategic investment: **dual-planner sweeps for tier-3+
escalation runs**, where the cost of a dead run is highest (most tokens
already invested). A second planner session runs in parallel. If either
produces a plan, the run continues. This converts the critical path from
OR-gated to AND-gated — both planners must fail for the run to die.

### 6.1 Dual-Planner Architecture

```
Planner sweep (OR-gated today):
  planner_session_0 ──────────► board items

Planner sweep (AND-gated tomorrow):
  planner_session_0 ──────────┬─► merge/dedup ─► board items
  planner_session_1 ──────────┘
  (only one must succeed)
```

**Cost**: 2× planner tokens per sweeps (~$10.34/sweep instead of $5.17)
for tier-3+ runs. Expected ROI: eliminates ~80% of dead runs at tier 3+,
saving ~$50/dead-run in operator time. Break-even at 1 prevented dead
run per 5 dual-sweeps.

**Implementation**: Not shipped. Queued in STATUS.md under "Graceful
degradation — promote orchestrator" extension. The dual-planner is the
AND-gate equivalent for self-organizing patterns.
