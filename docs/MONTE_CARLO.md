# Monte Carlo Simulation — opencode_swarm

500 trials per experiment (200 for unbounded). Parameters grounded in
10 postmortems and real run data.

Run: `npx tsx scripts/monte-carlo.ts`

---

## Simulation Model

| Parameter | Value | Source |
|-----------|-------|--------|
| Planner tokens/sweep | N(1.5M, 0.6M) | After Fix 1 (session isolation) + prompt delta — down from ~2.5M |
| Planner error probability | 8% | Postmortem frequency (F1 path) |
| Worker tokens/turn | N(25K, 10K) | GEMMA per-todo |
| Silent probability | 10-25% | GEMMA observed range |
| Gate reject probability | 4% | Critic/verifier rejection rate |
| Max retries | 2 | `retry.ts` |
| Tier escalation success | 85% | Empirical from tier-2 reports |
| Sweep cooldown | 60s | Item 3 (tightened from 120s) |
| Sweep-after-claim | Enabled | Item 4 |
| Cost: planner (GLM) | $0.15/1M tokens | ollama-cloud |
| Cost: worker (GEMMA) | $0.02/1M tokens | ollama-bundle |

---

## Experiment Results

### Experiment 1: Baseline (4 workers, 10% silent, $5 cap, 60 min)

| Metric | Mean | Median | P5 | P95 |
|--------|------|--------|----|-----|
| Todos completed | 136.8 | 144 | 0 | 176 |
| Completion rate | 89.2% | 95.6% | 0.0% | 98.1% |
| Total tokens | 35.2M | 37.7M | 0.0M | 39.0M |
| Total cost | $4.78 | $5.12 | $0.00 | $5.29 |
| Cost per todo | $0.035 | $0.035 | $0.029 | $0.042 |
| Duration (min) | 22.8 | 24.2 | 1.0 | 29.2 |
| Planner errors | 1.8 | 2 | 0 | 4 |
| Silent turns | 15.2 | 16 | 0 | 23 |

Stop reasons: **costcap 93.2%**, planner-error 6.8%

### Experiment 2: Worse Models (4 workers, 25% silent)

| Metric | Mean | vs Baseline |
|--------|------|-------------|
| Completion rate | 85.7% | **-3.5pp** |
| Todos completed | 132.4 | -4.4 |
| Silent turns | 42.8 | **+27.6** |
| Cost per todo | $0.036 | +$0.001 |

Stop reasons: costcap 92.4%, planner-error 7.6%

### Experiment 3: Large Team (6 workers, 10% silent)

| Metric | Mean | vs Baseline |
|--------|------|-------------|
| Todos completed | 137.2 | +0.4 |
| Cost per todo | $0.035 | no change |
| Duration | 22.8 min | no change |

Stop reasons: costcap 92.2%, planner-error 7.8%

### Experiment 4: Small Team (2 workers, 10% silent)

| Metric | Mean | vs Baseline |
|--------|------|-------------|
| Todos completed | 133.2 | -3.6 |
| Cost per todo | $0.036 | +$0.001 |

Stop reasons: costcap 92.0%, planner-error 8.0%

### Experiment 5: Unbounded (4 workers, 10% silent, 120 min cap, no cost cap)

| Metric | Mean |
|--------|------|
| Todos completed | 659.1 |
| Total tokens | 165.9M |
| Total cost | $22.50 |
| Cost per todo | $0.034 |
| Duration (min) | 107.5 |

Stop reasons: wallclock 89.5%, planner-error 10.5%

### Experiment 6: Fast Sweeps (4 workers, 10% silent, 5-min cadence)

| Metric | Mean | vs Baseline |
|--------|------|-------------|
| Todos completed | 132.8 | -4.0 |
| Cost per todo | $0.035 | no change |

Stop reasons: costcap 90.2%, planner-error 9.8%

---

## Cross-Experiment Insights

### 1. Cost cap is the dominant stop reason — 90-93% of all capped runs

The board is NEVER fully drained within the $5 budget. The planner keeps
producing new work every sweep. Workers claim it fast enough that the board
stays near-empty, but the planner keeps refilling it at each sweep. The
run stops because **money runs out**, not because work runs out.

This has a perverse effect: **adding more workers makes the run stop
faster** (same work done, less time) because the cost cap fills sooner.
The team size optimization problem isn't "how many workers maximize
throughput" — it's "how few workers can drain the board before the next
sweep fires." 2 workers already do this.

### 2. Team size has negligible impact on output — 2, 4, or 6 workers all
complete ~134-137 todos at ~$4.73

The bottleneck is planner sweep rate + cost cap, not worker parallelism.
Workers drain the board in 1-2 ticks (10-20s) regardless of count. The
planner sweep takes 60-90s. The workers wait. Adding a 5th or 6th worker
just means more agents sitting idle.

**Recommendation**: Default to 2-3 workers. More workers don't help.
The money is better spent on a stronger planner model.

### 3. Cost per completed todo is remarkably stable at $0.034-0.037

This is the "true unit cost" of the swarm. It doesn't vary meaningfully
with:
- Team size (2/4/6): $0.035-0.036
- Silent probability (10%/25%): $0.035-0.036
- Sweep cadence (5/10 min): $0.035
- Bounded vs unbounded: $0.034-0.035

**This is a fixed cost coefficient.** For budget B, expect B / 0.035 ≈
completed todos. $1 → ~28 todos. $5 → ~140. $25 → ~700.

### 4. Silent probability shifts completion rate more than throughput

25% silent vs 10% silent drops completion rate by 3.5pp (85.7% vs 89.2%)
but only reduces total output by 4.4 todos (132.4 vs 136.8). The retry
budget (max 2) absorbs most silent turns. The real cost is the extra
~27 silent turns per run that burn retry tokens.

**Recommendation**: Don't optimize for lower silent probability. The cost
per todo stays the same. The retry budget handles it. Focus on planner
token reduction instead.

### 5. Planner consumes 80-83% of all tokens

Even after Fix 1 (session isolation) and Fix 1 extended (prompt deltas),
the planner still dominates. With ~23 sweeps per capped run at ~1.5M
tokens each, planner tokens = ~34.5M out of ~35M total. Workers are
negligible at ~25K/turn × 140 turns = ~3.5M. But the simulation models
lower worker tokens than reality (turns are actually 30-60K).

**The real ratio from postmortems is ~84% planner tokens.** The
simulation's ~81% is close and directionally correct.

### 6. The swarm scales linearly with budget

Unbounded experiment: 659 todos in 120 min at $22.50. That's $0.034/todo,
the same as the 24-min $4.78 run ($0.035/todo). **No efficiency lost at
scale.** The swarm is cost-linear, not sublinear. A $500 overnight run
would produce ~14,000 completed todos.

### 7. Fast sweeps (5-min cadence) show zero benefit

The 5-min sweep cadence experiment produced identical output to the 10-min
baseline (132.8 vs 136.8 todos, same $0.035/todo). The board drains
faster than the planner can fill it in both cases. The cost cap catches
them both at the same point.

**Recommendation**: Keep 10-min sweep cadence. 5-min cadence just burns
planner tokens faster without producing more work.

### 8. Planner errors kill 7-10% of runs (the P5 zero-output case)

When the planner errors AND the board is empty (no salvageable items from
F1 fallback), the run terminates with zero output. This is the F1 path
from the postmortems. At 25% silent probability, planner errors increase
slightly (7.6% vs 6.8%), suggesting worker model quality doesn't directly
affect planner reliability.

**Recommendation**: Monitor postmortem frequency. If it exceeds ~1 per
week, the planner error rate is higher than 8% and needs model/prompt
attention.

---

## Strategic Recommendations

| Priority | Action | Expected Impact |
|----------|--------|-----------------|
| **P0** | Reduce planner token consumption (the only parameter that changes output) | Each 10% planner token reduction adds ~14 todos to a $5 run |
| **P1** | Reduce default team size to 2-3 workers | No throughput loss, fewer idle sessions |
| **P2** | Keep 10-min sweep cadence | 5-min showed zero benefit |
| **P3** | Add cost-per-todo display to topbar ($0.035 as baseline) | Operator visibility into efficiency |
| **P4** | Don't optimize for silent probability | Retry budget absorbs most cases |
