// @ts-nocheck
//
// Monte Carlo simulation of opencode_swarm run behavior.
// Models: token cost, silent-turn probability, planner errors,
// retry budgets, ambition ratchet, throughput per team size.
//
// Run: npx tsx scripts/monte-carlo.ts
//
// Parameters are grounded in real run data from 10 postmortems.

// ─── Types ───────────────────────────────────────────────────────────

interface RunResult {
  swarmRunID: string;     // trial identifier
  teamSize: number;
  silentProb: number;
  sweepCount: number;
  plannerTokens: number;
  workerTokens: number;
  totalTokens: number;
  totalCost: number;
  todosCompleted: number;
  todosStale: number;
  criteriaMet: number;
  criteriaUnmet: number;
  plannerErrors: number;
  silentTurns: number;
  gateRejects: number;
  durationMs: number;
  stoppedBy: 'drained' | 'wallclock' | 'costcap' | 'planner-error' | 'retry-exhausted';
  currentTier: number;
}

interface TrialParams {
  teamSize: number;
  silentProb: number;
  sweepIntervalMinutes: number;
  wallClockCapMinutes: number | null;  // null = unbounded
  costCapDollars: number | null;       // null = unbounded
}

// ─── Model Parameters ────────────────────────────────────────────────

const PLANNER = {
  tokensPerSweepMean: 1_500_000,   // ~1.5M after Fix 1 (session isolation + delta)
  tokensPerSweepStd: 600_000,
  errorProb: 0.08,
  costPer1MTokens: 0.15,           // GLM via ollama-cloud ($0.15/1M)
};

const WORKER = {
  tokensPerTurnMean: 25_000,       // GEMMA per-todo
  tokensPerTurnStd: 10_000,
  silentProbBase: 0.10,            // varies per trial
  gateRejectProb: 0.04,
  costPer1MTokens: 0.02,           // GEMMA via ollama-bundle ($0.02/1M)
};

const RETRY = {
  maxRetries: 2,
  retryTokenCostFraction: 0.7,     // retries usually finish faster (already explored)
};

const SWEEP = {
  tickIntervalMs: 10_000,          // 10s between ticks
  maxTiers: 5,
  // cadaverRatio: how much work each tier adds vs prior tier
  tierTodoMultiplier: [1.0, 0.8, 0.6, 0.4, 0.2],
  // cadaversionProbability: probability tier escalation succeeds
  tierEscalationSuccessProb: 0.85,
};

// ─── Random helpers ──────────────────────────────────────────────────

function normalRandom(mean: number, std: number): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function poissonRandom(lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  while (p > L) {
    k += 1;
    p *= Math.random();
  }
  return k - 1;
}

function randomId(length = 8): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ─── Single trial simulation ────────────────────────────────────────

function simulateTrial(params: TrialParams, trialIndex: number): RunResult {
  const { teamSize, silentProb, sweepIntervalMinutes, wallClockCapMinutes, costCapDollars } = params;

  const tickMs = SWEEP.tickIntervalMs;
  const sweepIntervalMs = sweepIntervalMinutes * 60_000;
  const wallClockDeadline = wallClockCapMinutes ? wallClockCapMinutes * 60_000 : Number.MAX_SAFE_INTEGER;

  // State
  let openTodos = 0;
  let inProgressCount = 0;
  let doneCount = 0;
  let staleCount = 0;
  let criteriaMet = 0;
  let criteriaUnmet = 0;
  let plannerTokens = 0;
  let workerTokens = 0;
  let plannerErrors = 0;
  let silentTurns = 0;
  let gateRejects = 0;
  let sweepCount = 0;
  let currentTier = 1;
  let lastSweepAtMs = 0;
  let elapsedMs = 0;

  // Audit criteria: at tiers 2+, planner creates criteria
  const openCriteria: boolean[] = []; // stack: true if met, false if unmet
  const WORKERS = teamSize;

  // Simulation loop
  let iterations = 0;
  const MAX_ITERATIONS = 10_000;  // safety — prevents infinite loops
  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    elapsedMs += tickMs;

    // Check caps
    const projectedCost = computeCost(plannerTokens, workerTokens);
    if (costCapDollars && projectedCost >= costCapDollars) {
      return buildResult(trialIndex, params, {
        todosCompleted: doneCount,
        todosStale: staleCount,
        criteriaMet,
        criteriaUnmet: openCriteria.filter(c => !c).length,
        plannerTokens,
        workerTokens,
        plannerErrors,
        silentTurns,
        gateRejects,
        sweepCount,
        durationMs: elapsedMs,
        stoppedBy: 'costcap',
        currentTier,
      });
    }
    if (elapsedMs >= wallClockDeadline) {
      return buildResult(trialIndex, params, {
        todosCompleted: doneCount,
        todosStale: staleCount,
        criteriaMet,
        criteriaUnmet: openCriteria.filter(c => !c).length,
        plannerTokens,
        workerTokens,
        plannerErrors,
        silentTurns,
        gateRejects,
        sweepCount,
        durationMs: elapsedMs,
        stoppedBy: 'wallclock',
        currentTier,
      });
    }

    // Eager re-sweep: fire if board is empty and cooldown passed
    const canSweep = elapsedMs - lastSweepAtMs >= 60_000; // 60s cooldown (item 3)
    const needSweep = openTodos === 0 && inProgressCount === 0 && !isBoardDrained();
    if (needSweep && canSweep) {
      const sweepResult = runSweep(currentTier, sweepCount);
      sweepCount += 1;
      lastSweepAtMs = elapsedMs;
      if (sweepResult.error) {
        plannerErrors += 1;
        if (openTodos + inProgressCount + doneCount === 0) {
          return buildResult(trialIndex, params, {
            todosCompleted: doneCount,
            todosStale: staleCount,
            criteriaMet,
            criteriaUnmet: openCriteria.filter(c => !c).length,
            plannerTokens,
            workerTokens,
            plannerErrors,
            silentTurns,
            gateRejects,
            sweepCount,
            durationMs: elapsedMs,
            stoppedBy: 'planner-error',
            currentTier,
          });
        }
        // F1: board has items — continue
      } else {
        plannerTokens += sweepResult.tokens;
        openTodos += sweepResult.todos;
        for (let i = 0; i < sweepResult.criteria; i += 1) openCriteria.push(false);
        // Tier escalation check
        if (isBoardDrained() && currentTier < SWEEP.maxTiers && Math.random() < SWEEP.tierEscalationSuccessProb) {
          currentTier += 1;
        }
      }
    }

    // Periodic re-sweep
    if (elapsedMs - lastSweepAtMs >= sweepIntervalMs) {
      const sweepResult = runSweep(currentTier, sweepCount);
      sweepCount += 1;
      lastSweepAtMs = elapsedMs;
      if (sweepResult.error) {
        plannerErrors += 1;
        if (openTodos + inProgressCount + doneCount === 0) {
          return buildResult(trialIndex, params, {
            todosCompleted: doneCount,
            todosStale: staleCount,
            criteriaMet,
            criteriaUnmet: openCriteria.filter(c => !c).length,
            plannerTokens,
            workerTokens,
            plannerErrors,
            silentTurns,
            gateRejects,
            sweepCount,
            durationMs: elapsedMs,
            stoppedBy: 'planner-error',
            currentTier,
          });
        }
      } else {
        plannerTokens += sweepResult.tokens;
        openTodos += sweepResult.todos;
        for (let i = 0; i < sweepResult.criteria; i += 1) openCriteria.push(false);
      }
    }

    // Workers claim + work
    for (let w = 0; w < WORKERS; w += 1) {
      if (openTodos <= 0) break;

      // Claim one
      openTodos -= 1;
      inProgressCount += 1;

      // Worker turn — may be silent
      const isSilent = Math.random() < silentProb;
      if (isSilent) {
        silentTurns += 1;
        const tokens = clamp(normalRandom(WORKER.tokensPerTurnMean * RETRY.retryTokenCostFraction, WORKER.tokensPerTurnStd * 0.5), 5_000, 50_000);
        workerTokens += tokens;

        // Retry logic
        let retried = 0;
        while (retried < RETRY.maxRetries) {
          retried += 1;
          const rtokens = clamp(normalRandom(WORKER.tokensPerTurnMean * RETRY.retryTokenCostFraction, WORKER.tokensPerTurnStd * 0.5), 5_000, 50_000);
          workerTokens += rtokens;
          const retrySilent = Math.random() < silentProb * 0.7; // lower prob on retry (already explored)
          if (!retrySilent) break;
          silentTurns += 1;
        }

        if (retried >= RETRY.maxRetries) {
          staleCount += 1;
        } else {
          doneCount += 1;
          // Auditor verifies criteria
          for (let c = 0; c < openCriteria.length; c += 1) {
            if (!openCriteria[c] && Math.random() < 0.6) {
              openCriteria[c] = true;
              criteriaMet += 1;
              break;
            }
          }
        }
        inProgressCount -= 1;
      } else {
        // Normal completion
        const tokens = clamp(normalRandom(WORKER.tokensPerTurnMean, WORKER.tokensPerTurnStd), 8_000, 80_000);
        workerTokens += tokens;

        // Gate rejection
        if (Math.random() < WORKER.gateRejectProb) {
          gateRejects += 1;
          const rtokens = clamp(normalRandom(WORKER.tokensPerTurnMean * 0.5, WORKER.tokensPerTurnStd * 0.3), 5_000, 40_000);
          workerTokens += rtokens;
          staleCount += 1;
        } else {
          doneCount += 1;
          for (let c = 0; c < openCriteria.length; c += 1) {
            if (!openCriteria[c] && Math.random() < 0.5) {
              openCriteria[c] = true;
              criteriaMet += 1;
              break;
            }
          }
        }
        inProgressCount -= 1;
      }
    }

    // Auto-stop: board drained, no work in flight
    if (openTodos === 0 && inProgressCount === 0 && isBoardDrained()) {
      // Count unmet criteria
      criteriaUnmet = openCriteria.filter(c => !c).length;
      return buildResult(trialIndex, params, {
        todosCompleted: doneCount,
        todosStale: staleCount,
        criteriaMet,
        criteriaUnmet,
        plannerTokens,
        workerTokens,
        plannerErrors,
        silentTurns,
        gateRejects,
        sweepCount,
        durationMs: elapsedMs,
        stoppedBy: 'drained',
        currentTier,
      });
    }
  }
  // Safety: loop limit reached. Return whatever state we have.
  return buildResult(trialIndex, params, {
    todosCompleted: doneCount,
    todosStale: staleCount,
    criteriaMet,
    criteriaUnmet: openCriteria.filter(c => !c).length,
    plannerTokens,
    workerTokens,
    plannerErrors,
    silentTurns,
    gateRejects,
    sweepCount,
    durationMs: elapsedMs,
    stoppedBy: 'drained',
    currentTier,
  });
}

function isBoardDrained(): boolean {
  // Placeholder — actual check is in the boards
  return false; // The loop handles this
}

function runSweep(tier: number, sweepNumber: number): { todos: number; criteria: number; tokens: number; error: boolean } {
  const error = Math.random() < PLANNER.errorProb;
  const tokens = clamp(normalRandom(PLANNER.tokensPerSweepMean, PLANNER.tokensPerSweepStd), 300_000, 4_000_000);
  if (error) return { todos: 0, criteria: 0, tokens: tokens * 0.3, error: true };

  const baseTodos = clamp(poissonRandom(7), 2, 15);
  const tierFactor = SWEEP.tierTodoMultiplier[Math.min(tier - 1, SWEEP.maxTiers - 1)];
  const todos = Math.max(1, Math.round(baseTodos * tierFactor));
  const criteria = tier > 1 ? clamp(poissonRandom(2), 1, 4) : clamp(poissonRandom(1), 0, 2);
  return { todos, criteria, tokens, error: false };
}

function computeCost(plannerTokens: number, workerTokens: number): number {
  return (plannerTokens / 1_000_000) * PLANNER.costPer1MTokens +
         (workerTokens / 1_000_000) * WORKER.costPer1MTokens;
}

function buildResult(idx: number, params: TrialParams, data: {
  todosCompleted: number;
  todosStale: number;
  criteriaMet: number;
  criteriaUnmet: number;
  plannerTokens: number;
  workerTokens: number;
  plannerErrors: number;
  silentTurns: number;
  gateRejects: number;
  sweepCount: number;
  durationMs: number;
  stoppedBy: RunResult['stoppedBy'];
  currentTier: number;
}): RunResult {
  return {
    swarmRunID: `sim_${String(idx).padStart(4, '0')}_${randomId(4)}`,
    teamSize: params.teamSize,
    silentProb: params.silentProb,
    sweepCount: data.sweepCount,
    plannerTokens: data.plannerTokens,
    workerTokens: data.workerTokens,
    totalTokens: data.plannerTokens + data.workerTokens,
    totalCost: computeCost(data.plannerTokens, data.workerTokens),
    todosCompleted: data.todosCompleted,
    todosStale: data.todosStale,
    criteriaMet: data.criteriaMet,
    criteriaUnmet: data.criteriaUnmet,
    plannerErrors: data.plannerErrors,
    silentTurns: data.silentTurns,
    gateRejects: data.gateRejects,
    durationMs: data.durationMs,
    stoppedBy: data.stoppedBy,
    currentTier: data.currentTier,
  };
}

// ─── Experiment runner ───────────────────────────────────────────────

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

interface Experiment {
  label: string;
  params: TrialParams;
  trials: number;
  results: RunResult[];
}

function runExperiment(exp: Experiment): void {
  exp.results = [];
  for (let i = 0; i < exp.trials; i += 1) {
    exp.results.push(simulateTrial(exp.params, i));
  }
}

function summarizeExperiment(exp: Experiment): string {
  const r = exp.results;
  const completed = r.map(x => x.todosCompleted);
  const stale = r.map(x => x.todosStale);
  const cost = r.map(x => x.totalCost);
  const tokens = r.map(x => x.totalTokens);
  const durationMin = r.map(x => x.durationMs / 60_000);
  const plannerErrors = r.map(x => x.plannerErrors);
  const silentTurns = r.map(x => x.silentTurns);
  const costPerTodo = r
    .filter(x => x.todosCompleted > 0)
    .map(x => x.totalCost / x.todosCompleted);
  const completionRate = r.map(x => x.todosCompleted / Math.max(1, x.todosCompleted + x.todosStale));
  const sweepCounts = r.map(x => x.sweepCount);
  const stopReasons: Record<string, number> = {};
  for (const x of r) stopReasons[x.stoppedBy] = (stopReasons[x.stoppedBy] ?? 0) + 1;

  const lines: string[] = [];
  lines.push(`\n## ${exp.label}`);
  lines.push(`  N = ${r.length} trials, team = ${exp.params.teamSize} workers, silentProb = ${exp.params.silentProb}`);
  lines.push('');
  lines.push(`| Metric | Mean | Median | P5 | P95 |`);
  lines.push(`|--------|------|--------|----|-----|`);
  lines.push(`| Todos completed | ${mean(completed).toFixed(1)} | ${median(completed).toFixed(0)} | ${pct(completed, 5).toFixed(0)} | ${pct(completed, 95).toFixed(0)} |`);
  lines.push(`| Todos stale | ${mean(stale).toFixed(1)} | ${median(stale).toFixed(0)} | ${pct(stale, 5).toFixed(0)} | ${pct(stale, 95).toFixed(0)} |`);
  lines.push(`| Completion rate | ${(mean(completionRate) * 100).toFixed(1)}% | ${(median(completionRate) * 100).toFixed(1)}% | ${(pct(completionRate, 5) * 100).toFixed(1)}% | ${(pct(completionRate, 95) * 100).toFixed(1)}% |`);
  lines.push(`| Total tokens | ${(mean(tokens) / 1e6).toFixed(1)}M | ${(median(tokens) / 1e6).toFixed(1)}M | ${(pct(tokens, 5) / 1e6).toFixed(1)}M | ${(pct(tokens, 95) / 1e6).toFixed(1)}M |`);
  lines.push(`| Total cost | $${mean(cost).toFixed(2)} | $${median(cost).toFixed(2)} | $${pct(cost, 5).toFixed(2)} | $${pct(cost, 95).toFixed(2)} |`);
  lines.push(`| Cost per completed todo | $${mean(costPerTodo).toFixed(3)} | $${median(costPerTodo).toFixed(3)} | $${pct(costPerTodo, 5).toFixed(3)} | $${pct(costPerTodo, 95).toFixed(3)} |`);
  lines.push(`| Duration (min) | ${mean(durationMin).toFixed(1)} | ${median(durationMin).toFixed(1)} | ${pct(durationMin, 5).toFixed(1)} | ${pct(durationMin, 95).toFixed(1)} |`);
  lines.push(`| Planner errors | ${mean(plannerErrors).toFixed(1)} | ${median(plannerErrors).toFixed(0)} | ${pct(plannerErrors, 5).toFixed(0)} | ${pct(plannerErrors, 95).toFixed(0)} |`);
  lines.push(`| Silent turns | ${mean(silentTurns).toFixed(1)} | ${median(silentTurns).toFixed(0)} | ${pct(silentTurns, 5).toFixed(0)} | ${pct(silentTurns, 95).toFixed(0)} |`);
  lines.push(`| Sweeps | ${mean(sweepCounts).toFixed(1)} | ${median(sweepCounts).toFixed(0)} | ${pct(sweepCounts, 5).toFixed(0)} | ${pct(sweepCounts, 95).toFixed(0)} |`);
  lines.push('');
  lines.push('Stop reasons:');
  for (const [reason, count] of Object.entries(stopReasons).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${reason}: ${count} (${(count / r.length * 100).toFixed(1)}%)`);
  }
  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────

function main(): void {
  const TRIALS = 500;

  const experiments: Experiment[] = [
    {
      label: 'Baseline: 4 workers, 10% silent',
      params: { teamSize: 4, silentProb: 0.10, sweepIntervalMinutes: 10, wallClockCapMinutes: 60, costCapDollars: 5 },
      trials: TRIALS, results: [],
    },
    {
      label: 'Worse models: 4 workers, 25% silent',
      params: { teamSize: 4, silentProb: 0.25, sweepIntervalMinutes: 10, wallClockCapMinutes: 60, costCapDollars: 5 },
      trials: TRIALS, results: [],
    },
    {
      label: 'Large team: 6 workers, 10% silent',
      params: { teamSize: 6, silentProb: 0.10, sweepIntervalMinutes: 10, wallClockCapMinutes: 60, costCapDollars: 5 },
      trials: TRIALS, results: [],
    },
    {
      label: 'Small team: 2 workers, 10% silent',
      params: { teamSize: 2, silentProb: 0.10, sweepIntervalMinutes: 10, wallClockCapMinutes: 60, costCapDollars: 5 },
      trials: TRIALS, results: [],
    },
    {
      label: 'Unbounded: 4 workers, 10% silent, 120-min hard cap',
      params: { teamSize: 4, silentProb: 0.10, sweepIntervalMinutes: 10, wallClockCapMinutes: 120, costCapDollars: null },
      trials: 200, results: [],
    },
    {
      label: 'Fast sweeps: 4 workers, 10% silent, 5-min cadence',
      params: { teamSize: 4, silentProb: 0.10, sweepIntervalMinutes: 5, wallClockCapMinutes: 60, costCapDollars: 5 },
      trials: TRIALS, results: [],
    },
  ];

  console.log('# Monte Carlo Simulation — opencode_swarm');
  console.log(`\n${TRIALS} trials per experiment. Parameters grounded in 10 postmortems.`);
  console.log('\n**Model notes**:');
  console.log('- Planner: ~1.5M tokens/sweep (after Fix 1 session isolation + prompt delta)');
  console.log('- Worker: ~25K tokens/turn (GEMMA), 10-25% silent probability');
  console.log('- Retries: max 2, silent probability decreases on retry');
  console.log('- Sweeps: 60s cooldown (item 3), eager on board drain (item 4)');
  console.log('- Caps: 60 min wallclock, $5 cost (baseline experiments)');

  for (const exp of experiments) {
    process.stdout.write(`\nRunning: ${exp.label}...`);
    runExperiment(exp);
    console.log(' done');
    console.log(summarizeExperiment(exp));
  }

  // ─── Cross-experiment insight ──────────────────────────────────────
  console.log('\n## Cross-Experiment Insights');
  console.log('');
  console.log('### Cost efficiency (cost per completed todo)');
  console.log('');
  console.log('| Experiment | Mean $/todo | P95 $/todo |');
  console.log('|-----------|------------|-----------|');
  for (const exp of experiments) {
    const costPerTodo = exp.results
      .filter(x => x.todosCompleted > 0)
      .map(x => x.totalCost / x.todosCompleted);
    console.log(`| ${exp.label} | $${mean(costPerTodo).toFixed(3)} | $${pct(costPerTodo, 95).toFixed(3)} |`);
  }

  console.log('');
  console.log('### Reliability (completion rate %)');
  console.log('');
  console.log('| Experiment | Mean | P5 | P95 |');
  console.log('|-----------|------|----|-----|');
  for (const exp of experiments) {
    const rate = exp.results.map(x => x.todosCompleted / Math.max(1, x.todosCompleted + x.todosStale));
    console.log(`| ${exp.label} | ${(mean(rate) * 100).toFixed(1)}% | ${(pct(rate, 5) * 100).toFixed(1)}% | ${(pct(rate, 95) * 100).toFixed(1)}% |`);
  }

  console.log('');
  console.log('### Planner token share (% of total)');
  console.log('');
  console.log('| Experiment | Mean | Median |');
  console.log('|-----------|------|--------|');
  for (const exp of experiments) {
    const share = exp.results.map(x => x.plannerTokens / Math.max(1, x.totalTokens) * 100);
    console.log(`| ${exp.label} | ${mean(share).toFixed(1)}% | ${median(share).toFixed(1)}% |`);
  }

  console.log('\n**Key**: P5 = 5th percentile (worst-case but survivable), P95 = 95th percentile (best-case, rare).');
}

main();
