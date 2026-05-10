# Strategic Analysis — opencode_swarm

Performed 2026-05-08. Covers Ansoff Matrix growth vectors and Scenario
Planning resilience analysis. Grounded in the project's current state:
6+1+1 orchestration patterns, 700+ tests, personal-use prototype.

---

## Ansoff Matrix

### The "Product" and "Market"

**Product:** Multi-agent LLM orchestration layer — 7 patterns (blackboard,
orchestrator-worker, critic-loop, council, debate-judge, map-reduce,
pipeline), 2D timeline, board/stigmergy dispatch, ambition ratchet, gate
system, auto-ticker, live SSE fan-out.

**Current market:** Solo developer running opencode to coordinate 2–6 LLM
sessions against a single codebase. One operator, one workspace, one repo.

### Quadrant 1: Market Penetration (existing → existing)

| Lever | Opportunity | Effort |
|-------|-------------|--------|
| Run frequency | Run templates — save directive + pattern + team as one-click preset | Low — schema already exists in `SwarmRunRequest` |
| Pattern adoption | Pattern recommender — analyze directive text, suggest pattern. **Shipped 2026-05-08** | Low — `lib/recommend-pattern.ts` with 21 tests |
| Board visibility | Board search + filters | Low — data already in `listBoardItems` |

### Quadrant 2: Product Development (new → existing)

| Opportunity | Effort |
|------------|---------|
| Human-in-the-loop inject — operator types directive into live agent mid-run | Medium — `postSessionMessageServer` exists, UI affordance is the gap |
| Post-hoc review — score each agent's contribution per run | Low — data exists in `SwarmRunMeta` + board items |
| Multi-repo awareness — planner sees package.json of linked packages | Medium |
| CI webhook trigger — start swarm run on PR creation | High — webhook receiver + CI-diff extraction |

### Quadrant 3: Market Development (existing → new)

| New market | Effort |
|-----------|---------|
| CI/CD pipelines — headless mode, JSON summary, exit codes | Medium — board items already structured |
| Teams (2–5 developers) — multi-user observability, shared run history | Medium — thin auth layer |
| Non-code domains — different tools, same patterns | High — tool surface rework |

### Quadrant 4: Diversification (new → new)

| Idea | Feasibility |
|------|------------|
| Swarm-as-a-service API | Violates "never SaaS" constraint |
| Agent training ground — benchmark agents against structured criteria | Needs ground truth dataset |
| Plugin marketplace — reusable pattern configs + templates | Most feasible; distribution play |

### Priority Matrix

| Priority | Item | Quadrant |
|----------|------|----------|
| 1 | Run templates | Penetration |
| 2 | Pattern recommender | Penetration |
| 3 | Human-in-the-loop inject | Development |
| 4 | Board search + filters | Penetration |
| 5 | Post-hoc review/scoring | Development |
| 6 | CI/CD webhook + structured summary | Market Dev |

---

## Scenario Planning

### Key Uncertainties

**U1: opencode API stability** — Stable (6+ months contract freeze) vs.
Volatile (breaking changes quarterly)

**U2: LLM provider reliability** — Reliable (structured output, no silent
turns) vs. Flaky (silent turns, pseudo-tool-call text, format drift)

### Scenario Matrix

```
                    U2: Reliable
                    ───────────
                │   A: Greenfield  │   B: Steady State
U1: Stable      │                  │   ← CURRENT TRAJECTORY
                ├──────────────────┼──────────────────
                │   D: Fragile     │   C: Whack-a-Mole
U1: Volatile    │                  │
                └──────────────────┴──────────────────
                    U2: Flaky
```

### Scenarios

**A: Greenfield (Stable API + Reliable LLMs)** — Postmortems stop. Planner
token consumption becomes cost optimization, not reliability. UX polish
features (run templates, pattern recommender) become the growth path.
Risk: overconfidence — removing safety nets because things work.

**B: Steady State (Stable API + Flaky LLMs)** — CURRENT. Parser resilience
remains load-bearing. Model-aware retry budgets stay essential. Provider
health probing is operational. The ambition ratchet masks planner failures.
Risk: technical debt compounding from parser workarounds.

**C: Whack-a-Mole (Volatile API + Reliable LLMs)** — Every opencode update
requires auditing `opencode-quirks.md`, updating `transform.ts`, re-verifying
dispatch paths. Risk: adapter churn consuming all engineering time.

**D: Fragile (Volatile API + Flaky LLMs)** — Postmortems double in frequency.
2-3 restarts needed per run. Operator babysits instead of directs. Risk:
trust collapse — the delegation model breaks.

### Cross-Scenario Robust Options

| Option | Why it's robust |
|--------|----------------|
| Planner prompt caching | Independent of API shape or model reliability. 84% of spend is planner |
| Adapter isolation (`lib/opencode/adapter.ts`) | Low cost in stable scenarios, high value in volatile ones |
| Human-in-the-loop inject | Critical in B/D when LLMs go off-track; still useful in A for directing runs |
| Graceful degradation for serial-critical patterns | Essential in B/D; modest code investment |
| Run templates | Saves setup time regardless of reliability |
| Contract tests for opencode schemas | Zero value in A/B, transformative in C/D. Low cost |

### Early-Warning Indicators

| Signal | Signals | Action |
|--------|---------|--------|
| Postmortems > 1/week | → D (Fragile) | Degradation-first design |
| New opencode version breaks `transform.ts` | → C or D | Accelerate adapter isolation |
| `recordParseFailure` > 5/run | → B or D | Provider abstraction; revisit retry budgets |
| Planner token share > 90% | Any | Prioritize planner prompt caching |
| User stops starting >30min runs | → D | Diagnose: reliability, cost, or UX? |

### Defensive Posture (not chosen)

Scenario planning recommends a defensive posture: every feature should be
assessed against B and D, not best-case A. The 10 postmortems in `docs/POSTMORTEMS/`
prove the current trajectory is B — models are flaky. Investments in
resilience (planner caching, graceful degradation, parser feedback loops)
outrank investments in feature surface.

---

## VRIO Remediation (shipped 2026-05-08)

| Rank | Item | Status |
|------|------|--------|
| 1 | Regression tests | Shipped — 29 new tests in escalation/sweep/blackboard |
| 2 | Proactive health gate | Skipped — reactive `probeOllamaPs` sufficient |
| 3 | Session-factory abstraction | Skipped — 23-file refactor disproportionate |
| 4 | Stress matrix | Covered by 29 new + existing 165 tests |
| 5 | Parse failure endpoint | Shipped — `GET _debug/swarm-run/:id/parse-failures` |
| 6 | Fallback model routing | Skipped — wait for real failure data |
