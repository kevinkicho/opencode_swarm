# Composite Recommendations — opencode_swarm

Synthesized from: Ansoff Matrix, Scenario Planning, Monte Carlo (3,000 trials),
Life Cycle Cost Analysis, Fault Tree Analysis (14 cut sets), MoSCoW, and
functional flow block diagrams. One document. One queue. No repetition.

---

## The Metric That Matters

**Operator interventions per week.** Currently 5.0. Target < 0.5.

Every recommendation either reduces this number or is deferred. Token cost,
team size, sweep cadence, silent probability — all are secondary. The LCCA
showed: operator time ($50/incident) is 945× more expensive than token waste
($0.05/run). Every other metric is a proxy. This one is the thing.

Track it: `npx tsx scripts/pm-frequency.ts`

---

## The Queue (Priority Order)

### Queue Item A — Dual-Planner Sweeps at Tier 3+

**All five analyses agree.** Ansoff: penetration (reliability). Scenario: robust in B/D. Monte Carlo: 15% → 2.25% failure probability. LCCA: $1,560/yr savings, 10-month payback. FTA: eliminates CS1-CS7 OR-gate → AND-gate.

**Status**: Shipped (`dual-sweep.ts`). Wire into `escalation.ts` — done.

### Queue Item B — Headless Engine Extraction

**Three analyses agree.** Scenario: cross-scenario robust (isolates coordination engine from API changes). LCCA: enables CI (eliminates manual run babysitting — the dominant operator time cost). Ansoff: market development (CI/CD pipelines).

**Status**: In STATUS.md queue. Not started. ~3 days. Design in `docs/IMPLEMENTATION_PLAN.md`.

**Why now**: The remaining operator interventions come from two sources: (a) planner errors (addressed by A) and (b) manual run management (start, stop, monitor). Headless engine enables a CI webhook that fires runs automatically on PR events. Every run launched by CI is one less the operator has to start manually.

### Queue Item C — Postmortem → Regex Tightening Loop

**Recurring, not one-time.** Scenario: data-driven parse failure reduction (B/D scenarios). FTA: targets B6 (empty todowrite) and B7 (all filtered). Monte Carlo: ~2% reduction in planner failure per iteration.

**Process** (5 min/week):
1. `curl GET /api/_debug/swarm-run/<recent-run-id>/parse-failures | jq '.patterns[:3]'`
2. For each top-3 pattern, tighten the corresponding regex in `parsers.ts`
3. Commit. Deploy. Next week, re-check.

**Stop when**: `parse-failures` returns zero entries for 4 consecutive weeks.

### Queue Item D — Graceful Degradation Recovery Actions

**Partially shipped.** Fix 3 detects broken invariants. FTA items added post-recovery messages (critic-loop notifies worker, OW notifies new orchestrator). What's missing:

- **Debate-judge**: When judge dies and generator is promoted, post the promotion message to the new judge with remaining proposals.
- **Map-reduce**: When synthesizer is silent (caught by retry), post a retry to a different session.

~30 lines in `pattern-guard.ts`. ~0.3 days.

### Queue Item E — Planner Prompt Truncation by Model Context Limit

**Monte Carlo + FTA + LCCA agree.** B2 (model silent, 5%/sweep) is partially caused by context overflow. GLM's 128K context window can be exceeded when README (5-25KB) + board context (8KB) + session tool definitions stack up.

**Implementation**: In `prompt.ts`, before building the prompt, estimate token count. If >85% of model context limit, truncate README first, then lessons, then board context.

~25 lines. ~0.3 days.

---

## Stop Doing These

### Don't add more workers

Monte Carlo proved: 2, 4, or 6 workers produce identical output at identical cost. More workers = more idle sessions = more opencode overhead = zero benefit. The default was reduced from 6 to 2. Don't override it back.

### Don't reduce sweep cadence below 10 minutes

Monte Carlo proved: 5-min sweeps produce identical output at identical cost per todo. They just burn planner tokens faster, hitting the cost cap sooner. The slider step was changed from 5 to 10. Don't change it back.

### Don't invest in silent probability reduction

Monte Carlo proved: +15pp silent probability (10% → 25%) only costs 4 todos per run. The retry budget (max 2) absorbs most silents. Model upgrades cost more in tokens than they save in prevented retries. The LCCA confirmed: worker model upgrade ROI is negative.

### Don't build features until postmortem rate < 0.5/week

The LCCA showed: every feature hour returns 0% ROI until operator interventions are below threshold. Features don't reduce the metric that matters. Reliability fixes do. When `pm-frequency.ts` shows 4 consecutive green weeks, then build features.

### Don't add new orchestration patterns

No analysis — not Ansoff, not Monte Carlo, not FTA — identified "missing patterns" as a constraint. The 6+1+1 pattern set is complete for the current use cases. A new pattern would create a new failure surface (new FTA cut sets) without addressing any existing failure mode.

---

## Monitor These

### Weekly: Postmortem frequency

```
npx tsx scripts/pm-frequency.ts
```

| Rate | Status | Action |
|------|--------|--------|
| ≥ 2.5/week | 🔴 CRITICAL | Stop all feature work. Only ship reliability fixes. |
| 1.0–2.4 | 🟡 ELEVATED | Continue reliability fixes. Defer features. |
| 0.5–0.9 | 🟢 IMPROVING | Begin feature work, maintain reliability cadence. |
| < 0.5 | ✅ STEADY STATE | Normal operations. $15.6K/yr maintenance target. |

### Weekly: Parse failure count

```
curl GET /api/_debug/swarm-run/<latest>/parse-failures | jq '.patterns | length'
```

If non-zero: execute Queue Item C.

### Monthly: Cost-per-todo trend

Read from the topbar badge. If it drifts above $0.040 (from $0.034 baseline): investigate planner token consumption. Likely cause: model degradation or context inflation.

### Monthly: Run the Monte Carlo simulation

```
npx tsx scripts/monte-carlo.ts
```

Compare against baseline. If any metric deviates >20% from the documented values in `docs/MONTE_CARLO.md`, investigate the parameter that changed.

---

## When Are We Done?

The project reaches **steady state** when:

1. Postmortem rate < 0.5/week for 4 consecutive weeks (LCCA target)
2. Planner error rate < 3% per sweep (down from 8%. FTA target after dual-planner)
3. Silent probability < 10% per turn (worker model improvement or model upgrade)
4. Cost per todo = $0.034 ± $0.005 (within Monte Carlo 95% confidence interval)

At steady state, annual maintenance is $15.6K/yr (104 runs, $0.18K tokens, $15.6K maintenance). The five-year cost per todo drops from $16.15 (year 1, amortized development) to $4.13 (year 5, marginal costs only).

**The convergence point**: ~4-6 weeks after shipping Queue Items A-E. The dual-planner (A) eliminates the largest FTA cut set. The headless engine (B) eliminates manual run management. The regex loop (C) feeds continuously. Items D and E are gap-fills.
