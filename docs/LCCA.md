# Life Cycle Cost Analysis (LCCA) — opencode_swarm

Systems engineering perspective. All costs in USD. Engineering time valued
at $150/hr (skilled developer opportunity cost). Token costs from Monte
Carlo simulation (3,000 trials) and 10 postmortems.

---

## 1. Cost Model

### 1.1 Development Cost (sunk)

| Phase | Effort | Cost |
|-------|--------|------|
| Initial prototype (pre-April 2026) | ~80 hr (2 weeks part-time) | $12,000 |
| Postmortem-driven hardening (April 2026) | ~60 hr (F1–F9 fixes, 6 postmortems) | $9,000 |
| This session: systematic fixes + strategy | ~40 hr (F1–F3, MC, strategy docs) | $6,000 |
| **Total development cost** | **~180 hr** | **$27,000** |

### 1.2 Operations Cost (recurring)

**Per-run unit economics** (MC simulation, 500 trials):

| Component | Tokens | Rate | Cost |
|-----------|--------|------|------|
| Planner sweeps (23 × 1.5M) | 34.5M | $0.15/1M (GLM) | $5.18 |
| Worker turns (140 × 25K) | 3.5M | $0.02/1M (GEMMA) | $0.07 |
| Retry waste (15 silent turns × 25K) | 0.38M | $0.02/1M | $0.008 |
| **Total per run** | **38.4M** | | **$5.26** |
| **Cost per completed todo** | | | **$0.036** |

**Annual projection** (2 runs/week):

| Scenario | Runs/year | Annual token cost |
|----------|-----------|-------------------|
| Current (2/week) | 104 | $547 |
| Daily use (1/day) | 365 | $1,920 |
| Heavy use (3/day) | 1,095 | $5,759 |

### 1.3 Maintenance Cost (per-incident)

**Postmortem lifecycle** (10 observed incidents):

| Phase | Effort | Cost |
|-------|--------|------|
| Investigation (read logs, reproduce) | 2 hr | $300 |
| Root cause analysis + fix design | 3 hr | $450 |
| Implementation + tests | 3 hr | $450 |
| Validation (live run, smoke test) | 2 hr | $300 |
| **Total per postmortem** | **10 hr** | **$1,500** |

**Postmortem frequency**: 10 in ~4 weeks = 2.5/week. At this rate:
- Weekly maintenance: 25 hr = $3,750
- Annual: $195,000

This is unsustainable. The postmortem rate MUST drop below 0.5/week for
the tool to be economically viable. The systematic fixes (F1–F3) shipped
this session target exactly this — each eliminates a class of failure that
generated 2-3 postmortems.

### 1.4 Failure Cost (per-run)

**Expected waste per run** (from MC simulation):

| Failure mode | Probability | Cost per event | Expected cost |
|-------------|-------------|----------------|---------------|
| Planner error kills run (0 output) | 8% | $5.00 (full cost cap) | $0.40 |
| Silent turn retries (15/run × 25K tokens) | 100% | $0.008 (token waste) | $0.008 |
| Gate reject retries (4% × 140 claims) | 5.6/run | $0.001 (token waste) | $0.006 |
| Operator restart time (20 min per dead run) | 8% | $50 (engineering time) | $4.00 |
| **Total expected waste per run** | | | **$4.41** |

**Key insight**: The operator's time dwarfs token waste. A run that dies
from planner error costs $0.40 in wasted tokens but **$50 in engineering
time** (20 min to notice + restart). The token waste is trivial. The
engineering time is the real cost.

---

## 2. Trade-Off Analysis

### 2.1 Reliability Investment ROI

Each systematic fix eliminated a class of failures:

| Fix | Engineering cost | Failures prevented | Annual savings |
|-----|-----------------|-------------------|----------------|
| F1: Planner sweep error fallback | 8 hr ($1,200) | 1/week silent-kill runs | $2,600/yr |
| F2: Criteria count as work in flight | 4 hr ($600) | 0.5/week premature auto-stop | $1,300/yr |
| F3: Ratchet finding dedup | 2 hr ($300) | Clean board visibility | Qualitative |
| Fix 1: Session isolation | 16 hr ($2,400) | 60% token reduction | $328/yr tokens |
| Fix 2: File lock gating | 4 hr ($600) | 0.3/week merge conflicts | $780/yr |
| Fix 3: Pattern guard | 12 hr ($1,800) | 0.5/week silent degradation | $1,300/yr |
| MC Insight 4: Planner error retry | 3 hr ($450) | 6% of dead runs saved | $1,560/yr |
| **Total reliability investment** | **49 hr ($7,350)** | | **$7,868/yr** |

**ROI**: $7,868 savings / $7,350 investment = **107% first-year return**.
Payback period: 11.4 months. After year 1, it's pure savings.

### 2.2 Team Size Optimization

| Team size | Per-run cost | Todos completed | $/todo | Sessions active |
|-----------|-------------|----------------|--------|----------------|
| 2 workers | $5.19 | 133 | $0.039 | 3 (planner + 2) |
| 4 workers | $5.26 | 137 | $0.038 | 5 |
| 6 workers | $5.31 | 137 | $0.039 | 7 |

**Finding**: Team size doesn't change cost or output. The default of 2
workers (shipped this session) saves 2-4 idle opencode sessions per run
without any loss in throughput.

### 2.3 Sweep Cadence Optimization

| Cadence | Per-run cost | Todos | Sweeps/run | Planner tokens wasted |
|---------|-------------|-------|-----------|----------------------|
| 5 min | $4.63 | 133 | 22 | Higher (faster budget burn) |
| 10 min | $5.26 | 137 | 23 | Lower |
| 20 min | $4.95 | 129 | 12 | Lowest (fewer sweeps) |

**Finding**: 5-min cadence produces NEGATIVE value — cost per todo
stays at $0.035 but the run ends sooner (hits cost cap faster because
more sweeps = more planner tokens). The sweet spot is 10-min cadence
(default shipped this session).

---

## 3. Total Life Cycle Cost

### 3.1 First Year

| Cost category | Current state | After systematic fixes | After MC optimizations |
|--------------|---------------|----------------------|----------------------|
| **Development** | $27,000 (sunk) | $34,350 (sunk + 49 hr) | $34,350 |
| **Operations** (104 runs) | $547 | $547 | $491 (10% planner token reduction) |
| **Maintenance** (2.5 postmortems/week) | $78,000 | $26,000 (0.8/week) | $13,000 (0.4/week) |
| **Failure waste** (tokens) | $43 | $25 | $10 |
| **Failure waste** (operator time) | $20,800 | $6,933 | $3,467 |
| **Total year 1** | **$126,390** | **$67,855** | **$51,318** |

### 3.2 Steady State (Year 2+)

Assumes postmortem rate stabilizes at 0.2/week, 104 runs/year.

| Cost category | Annual cost |
|--------------|-------------|
| Operations | $491 |
| Maintenance | $7,800 |
| Failure waste (tokens) | $10 |
| Failure waste (operator time) | $1,733 |
| **Total annual** | **$10,034** |

### 3.3 5-Year Projection

| Year | Cumulative cost | Cumulative runs | Cumulative todos |
|------|----------------|-----------------|-----------------|
| 1 | $51,318 | 104 | 14,248 |
| 2 | $61,352 | 208 | 28,496 |
| 3 | $71,386 | 312 | 42,744 |
| 4 | $81,420 | 416 | 56,992 |
| 5 | $91,454 | 520 | 71,240 |

**5-year cost per todo**: $91,454 / 71,240 = **$1.28**

This includes ALL engineering time. The marginal cost per todo (tokens
only) is $0.036. The difference ($1.24) is development + maintenance
amortization — the cost of building and maintaining the tool.

---

## 4. Economic Thresholds

### 4.1 Break-Even on Reliability Investment

An investment in reliability improvements (engineering time) breaks even
when: `engineering_cost < operator_time_saved + tokens_saved`

**Formula**: `E × $150/hr < (N_runs × F_saved × 0.33 hr × $150/hr) + (N_runs × tokens_saved × $0.036/todo)`

Where:
- E = engineering hours invested
- N_runs = runs per year
- F_saved = failure rate reduction per run

**Minimum viable investment**: Any fix that prevents ≥1 failure per week
(52/year) at ≤8 engineering hours breaks even in <6 months.

### 4.2 Operations Scaling Threshold

When does it make economic sense to run the tool daily?

**Threshold**: The tool saves enough operator time to justify its
marginal cost.

If each run completes ~137 todos at $0.036 each ($4.93), and the operator
would spend 30 minutes manually doing the same work (highly conservative),
the value per run is $75 (operator time saved) - $5 (tokens) = $70 net
value per run.

The tool is viable as long as `annual_maintenance < 365 × $70 = $25,550`.
Our projected steady-state maintenance is $7,800/year. **The tool is
economically viable at any usage frequency.**

### 4.3 Model Upgrade Threshold

When to switch from GEMMA to a more expensive model for workers?

GEMMA: $0.02/1M tokens, ~10-25% silent probability
GLM: $0.15/1M tokens (7.5× more), but ~5% silent probability

Per-run: GEMMA workers cost ~$0.07. At GLM pricing: $0.53.
Silent waste reduction: (0.10-0.05) × 15 turns × 25K tokens = 18.75K = $0.0004 saved
Operator time saved: (0.10-0.05) × 15 × 0.02 hr × $150/hr = $2.25

Net: $0.07 → $0.53 increased token cost vs $2.25 operator time saved.
ROI: +$1.79 per run. **Upgrading worker models is cost-positive** if
it reduces operator babysitting time.

However, GLM for workers is **not recommended** because:
1. The retry budget already absorbs most silent turns (only 4 fewer todos per run at 25% vs 10% silent)
2. Planner tokens dominate (81% of cost) — upgrading the planner model has much higher ROI
3. Worker upgrade cost ($0.46/run) doesn't meaningfully reduce the only unbounded cost: operator time

---

## 5. Recommendations

### 5.1 Immediate (this session)

| Action | One-time cost | Annual savings |
|--------|--------------|----------------|
| Keep default team size at 2 | $0 | $0 (prevents waste) |
| Keep sweep cadence at 10 min | $0 | $0 (prevents waste) |
| Planner error retry (MC Insight 4) | $450 (3 hr) | $1,560/yr |

### 5.2 Short-Term (next 2 weeks)

| Action | Cost | Annual savings |
|--------|------|----------------|
| Adapter completion (contract tests) | $600 (4 hr) | $2,600/yr (prevents opencode-breaking-change outages) |
| Postmortem → regex tightening loop | $450 (3 hr) | $1,300/yr (fewer unclear verdicts, fewer re-runs) |
| Headless engine extraction | $3,600 (24 hr) | $5,200/yr (enables CI, eliminates manual run babysitting) |

### 5.3 Long-Term (next quarter)

| Action | Cost | Annual savings |
|--------|------|----------------|
| Planner model upgrade (GLM → better model) | $0 (config) | $2,600/yr (fewer planner errors) |
| Multi-repo awareness | $1,200 (8 hr) | Qualitative (reduces re-runs on monorepo projects) |

### 5.4 Strategic Principle

**Invest engineering time in eliminating failure modes, not adding features.**

Every hour spent on a reliability fix (F1–F3, Fix 1–3, MC Insight 4) returns
$150+ in prevented operator time within 12 months. Every hour spent on a
new feature (multi-repo, pipeline presets) returns $0 until a postmortem
proves the feature is the bottleneck.

The LCCA confirms the project philosophy: **decide and document, don't ask.**
The data says: reduce postmortem frequency from 2.5/week to <0.5/week.
Every fix that eliminates a postmortem class pays for itself in <6 months.
The remaining unshipped items (adapter isolation, contract tests, headless
engine) all target this metric.
