# Performance Analysis — opencode_swarm

Load testing, bottleneck identification, and benchmarking. All latencies
modeled from code paths (no live opencode daemon). Parameters grounded in
Monte Carlo simulation (3,000 trials) and UML sequence diagram.

Run: `npx tsx scripts/perf-bench.ts`

---

## 1. Critical Path Latencies

### Claim Latency (Pick → Dispatch)

| Board size | Mean | Min | Max | Dominant |
|-----------|------|-----|-----|----------|
| 10 items | 727ms | 427ms | 1,027ms | HTTP calls (88%) |
| 50 items | 747ms | 447ms | 1,047ms | HTTP calls (86%) |
| 100 items | 772ms | 472ms | 1,072ms | HTTP calls (84%) |
| 500 items | 972ms | 672ms | 1,272ms | HTTP calls (71%) |

**Finding P1**: Claim latency is dominated by opencode HTTP calls (session
message fetch + session reset = 900ms of 1,047ms max). Board size has
minimal impact — even 500 items adds only 245ms. The parallelized
session fetch (UML 5.5, shipped) keeps this constant regardless of
session count.

**No code optimization can reduce claim latency below ~400ms** because
that's the minimum time for: getSessionMessages (200ms) + CAS (2ms) +
SHA anchoring (120ms) + dispatch (100ms). The remaining time is the LLM
turn, which is external.

### Tick Latency (Claim → Commit)

| Component | Time | % |
|-----------|------|---|
| LLM turn (worker) | 30-120s | 95-97% |
| Claim overhead | 747ms | 2% |
| Gate checks | 650ms | 1% |
| Commit | 1ms | <0.01% |

**Finding P2**: A tick cycle spends 95-97% of its time waiting for the LLM.
The code path (claim, dispatch, gates, commit) is 1-3% of total latency.
No code-level optimization can improve tick throughput by more than 3%.

### Sweep Latency (Planner → Board Items)

| Sweep # | Mean | Dominant |
|---------|------|----------|
| #1 (cold) | 76.3s | LLM turn (98%) |
| #5 (warm) | 76.0s | LLM turn (98%) |
| #10+ | 76.0s | LLM turn (98%) |

**Finding P3**: Planner sweeps show zero warm-up benefit from cached
README + lessons (MC Insight 1). The 300ms savings from caching is
drowned by the 60s LLM turn. Caching is a COST optimization (fewer
tokens in prompt), not a latency optimization.

---

## 2. Throughput Analysis

| Sessions | Todos/min | Bottleneck |
|----------|-----------|------------|
| 2 | 3.0 | Workers (0.05/s) < Planner (0.08/s) |
| 4 | 6.0 | Planner (0.08/s) < Workers (0.10/s) |
| 6 | 9.0 | Planner (0.08/s) < Workers (0.15/s) |
| 8 | 12.0 | Planner (0.08/s) < Workers (0.20/s) |

**Finding P4**: The bottleneck shifts from workers to planner at 4+
sessions. With 2 workers, workers can't drain the board fast enough.
With 4+ workers, workers drain the board in 15-20s but the planner
takes 60-90s to produce new work. **The planner is the throughput
bottleneck at all team sizes above 3.** This matches the Monte Carlo
finding (SF6: team size doesn't matter).

---

## 3. Load Test Scenarios

| Scenario | Concurrent runs | opencode calls/s | SQLite ops/s | Tokens/hr | $/hr | Risk |
|----------|----------------|-----------------|-------------|-----------|------|------|
| Baseline (1 run) | 1 | 0.03 | 0.4 | 6.7M | $0.91 | LOW |
| Moderate (2 runs) | 2 | 0.06 | 1.6 | 13.4M | $1.83 | MEDIUM |
| Heavy (3 runs) | 3 | 0.14 | 7.1 | 30.2M | $4.11 | MEDIUM |
| Overnight (1 long) | 1 | 0.05 | 5.9 | 10.1M | $1.37 | LOW |

**Finding P5**: The coordination engine has negligible resource consumption.
At 3 concurrent runs (Heavy), opencode receives 0.14 calls/second and
SQLite handles 7 operations/second. These are trivially handled by any
modern system. The bottleneck is NOT the coordination engine — it's the
opencode daemon's LLM dispatch queue.

**The system can scale to 10+ concurrent runs before the coordination
engine becomes a bottleneck.** At that point, the SQLite WAL (Write-Ahead
Log) might show contention on rapid board scans. But the per-session
mutex already serializes access, making this unlikely.

---

## 4. Bottleneck Identification — Ranked

| Rank | Component | Latency | % of total | Category | Fixable? |
|------|-----------|---------|-----------|----------|----------|
| 1 | LLM turn (worker) | 30-120s | 96% | External | No — model inference is the constraint |
| 2 | LLM turn (planner) | 60-90s | 98% | External | No — model inference is the constraint |
| 3 | Session reset | 600ms | 1% | Internal | Shipped: session reset optimized (Fix 1) |
| 4 | Session fetch | 350ms | 0.6% | Internal | Shipped: parallelized (UML 5.5) |
| 5 | SHA anchoring | 120ms | 0.2% | Internal | No — drift check requires file hashes |
| 6 | Board scan (500 items) | 5ms | <0.01% | Internal | Shipped: BoardView cache (Flow 2) |
| 7 | Board context build | 3ms | <0.01% | Internal | Shipped: prompt delta (Flow 1) |
| 8 | CAS operations | 2ms | <0.01% | Internal | No — SQLite is already optimal |

**Finding P6**: All six internal bottlenecks (ranks 3-8, totaling <4% of
latency) are already optimized or inherent. The remaining two bottlenecks
(ranks 1-2, 96-98%) are external and cannot be optimized by code changes.

---

## 5. Benchmarking — Established Baselines

These baselines serve as regression thresholds. If any metric degrades
by more than 20%, investigate the change that caused it.

| Metric | Baseline | Degradation threshold |
|--------|----------|----------------------|
| Claim latency (50 items) | 747ms | >900ms (20%) |
| Tick latency (overhead) | 1.4s | >1.7s |
| Sweep latency (overhead) | 1.0s | >1.2s |
| Board scan (50 items) | 25ms | >30ms |
| CAS operations | 2ms | >3ms |
| Throughput (4 workers) | 6 todos/min | <4.8 todos/min |
| opencode calls/run/hr | 28 | >33 |
| SQLite ops/run/hr | 58 | >70 |

---

## 6. What Performance Analysis Reveals That Other Analyses Miss

| Analysis | Finding |
|----------|---------|
| Monte Carlo | Throughput is bottlenecked by planner sweep rate |
| UML Sequence | Claim latency has 3 sequential HTTP calls (fixed: parallelized) |
| Performance | **All code-level optimizations combined save <4% of total latency** |
| Performance | **The system can handle 10+ concurrent runs before coordination engine bottlenecks** |
| Performance | **The 96-98% latency spent in LLM turns is irreducible by code** |

**The verdict**: Performance optimization of the coordination engine has
diminishing returns below zero. The LLM dominates by 100-1000×. Every
code optimization already shipped (session isolation, parallel fetches,
BoardView cache, prompt delta) collectively save <4% of total tick time.
Further optimization would be engineering theater — impressive to
developers, invisible to operators.

**The real performance lever is model selection, not code.** A 2× faster
model doubles throughput. No amount of code optimization can achieve that.
The Monte Carlo simulation confirmed: cost cap stops 93% of runs, not
throughput. The binding constraint is budget, not code speed.
