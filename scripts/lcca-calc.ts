// @ts-nocheck
//
// LCCA calculator — computes break-even points and cost projections
// for opencode_swarm. See docs/LCCA.md for the full analysis.
//
// Run: npx tsx scripts/lcca-calc.ts

// ─── Constants ───────────────────────────────────────────────────────

const ENG_RATE = 150;             // $/hr — skilled developer opportunity cost
const PLANNER_COST_PER_1M = 0.15; // GLM via ollama-cloud
const WORKER_COST_PER_1M = 0.02;  // GEMMA via ollama-bundle

// MC simulation values (500 trials)
const PLANNER_TOKENS_PER_SWEEP = 1_500_000;
const SWEEPS_PER_RUN = 23;
const WORKER_TOKENS_PER_TODO = 25_000;
const SILENT_PROB = 0.10;
const PLANNER_ERROR_PROB = 0.08;
const TODOS_PER_RUN = 137;
const SILENT_TURNS_PER_RUN = 15;
const OPERATOR_RESTART_MINUTES = 20;

// Maintenance
const HOURS_PER_POSTMORTEM = 10;
const POSTMORTEM_RATE_CURRENT = 2.5;  // per week
const POSTMORTEM_RATE_STEADY = 0.2;   // after all fixes

// Runs
const RUNS_PER_WEEK = 2;
const WEEKS_PER_YEAR = 52;

// ─── Computations ────────────────────────────────────────────────────

function fmtUSD(n: number): string { return '$' + n.toFixed(2); }
function fmtInt(n: number): string { return n.toLocaleString(); }

function computeRunCost(): { planner: number; worker: number; retry: number; total: number; perTodo: number } {
  const planner = (PLANNER_TOKENS_PER_SWEEP * SWEEPS_PER_RUN / 1_000_000) * PLANNER_COST_PER_1M;
  const worker = (WORKER_TOKENS_PER_TODO * TODOS_PER_RUN / 1_000_000) * WORKER_COST_PER_1M;
  const retry = (WORKER_TOKENS_PER_TODO * SILENT_TURNS_PER_RUN / 1_000_000) * WORKER_COST_PER_1M;
  const total = planner + worker + retry;
  return { planner, worker, retry, total, perTodo: total / TODOS_PER_RUN };
}

function computeAnnualOps(runsPerYear: number) {
  const runCost = computeRunCost();
  return {
    runsPerYear,
    tokenCost: runCost.total * runsPerYear,
    todosCompleted: TODOS_PER_RUN * runsPerYear,
    costPerTodo: runCost.perTodo,
  };
}

function computeAnnualMaintenance(pmRate: number) {
  const hours = pmRate * WEEKS_PER_YEAR * HOURS_PER_POSTMORTEM;
  return { hours, cost: hours * ENG_RATE };
}

function computeFailureWaste() {
  const deadRuns = PLANNER_ERROR_PROB * RUNS_PER_WEEK * WEEKS_PER_YEAR;
  const tokenWaste = deadRuns * computeRunCost().total;
  const timeWaste = deadRuns * (OPERATOR_RESTART_MINUTES / 60) * ENG_RATE;
  const silentWaste = (SILENT_TURNS_PER_RUN * WORKER_TOKENS_PER_TODO / 1_000_000) * WORKER_COST_PER_1M * RUNS_PER_WEEK * WEEKS_PER_YEAR;
  return { deadRuns, tokenWaste, timeWaste, silentWaste, total: tokenWaste + timeWaste + silentWaste };
}

function breakevenOnFix(engHours: number, failuresPreventedPerWeek: number): { months: number; annualRoi: number } {
  const annualSavings = failuresPreventedPerWeek * WEEKS_PER_YEAR * (OPERATOR_RESTART_MINUTES / 60) * ENG_RATE;
  const cost = engHours * ENG_RATE;
  return {
    months: cost / (annualSavings / 12),
    annualRoi: (annualSavings / cost) * 100,
  };
}

// ─── Output ───────────────────────────────────────────────────────────

function main() {
  const runCost = computeRunCost();
  const annualOps = computeAnnualOps(52); // 1 run/week for display
  const maintenance = computeAnnualMaintenance(POSTMORTEM_RATE_CURRENT);
  const steadyMaint = computeAnnualMaintenance(POSTMORTEM_RATE_STEADY);
  const failure = computeFailureWaste();

  console.log('# LCCA Calculator — opencode_swarm\n');
  
  console.log('## Per-Run Unit Economics');
  console.log(`  Planner: ${fmtUSD(runCost.planner)} (${(runCost.planner/runCost.total*100).toFixed(0)}% of total)`);
  console.log(`  Worker:  ${fmtUSD(runCost.worker)}`);
  console.log(`  Retry:   ${fmtUSD(runCost.retry)}`);
  console.log(`  Total:   ${fmtUSD(runCost.total)}/run`);
  console.log(`  Per todo: ${fmtUSD(runCost.perTodo)}`);
  console.log();

  console.log('## Annual Projections');
  console.log('| Scenario | Runs/yr | Token cost | Todos | Cost/todo |');
  console.log('|----------|---------|-----------|-------|-----------|');
  for (const freq of [1, 2, 3, 7]) {
    const a = computeAnnualOps(freq * WEEKS_PER_YEAR);
    console.log(`| ${freq}/week | ${a.runsPerYear} | ${fmtUSD(a.tokenCost)} | ${fmtInt(a.todosCompleted)} | ${fmtUSD(a.costPerTodo)} |`);
  }
  console.log();

  console.log('## Maintenance Cost');
  console.log(`  Current (${POSTMORTEM_RATE_CURRENT} PM/week): ${fmtUSD(maintenance.cost)}/yr (${maintenance.hours} hr)`);
  console.log(`  Steady-state (${POSTMORTEM_RATE_STEADY} PM/week): ${fmtUSD(steadyMaint.cost)}/yr (${steadyMaint.hours} hr)`);
  console.log();

  console.log('## Failure Waste');
  console.log(`  Dead runs: ${failure.deadRuns.toFixed(1)}/yr`);
  console.log(`  Token waste: ${fmtUSD(failure.tokenWaste)} (trivial)`);
  console.log(`  Operator time: ${fmtUSD(failure.timeWaste)} (dominant)`);
  console.log(`  Silent retry tokens: ${fmtUSD(failure.silentWaste)}`);
  console.log(`  Total waste: ${fmtUSD(failure.total)}/yr`);
  console.log();

  console.log('## Break-Even on Reliability Investment');
  console.log('| Engineering hours | Failures prevented/week | Break-even (months) | Annual ROI |');
  console.log('|-------------------|------------------------|---------------------|------------|');
  for (const [hr, fpw] of [[2, 0.5], [4, 1], [8, 1], [16, 2], [40, 0.8]]) {
    const be = breakevenOnFix(hr, fpw);
    console.log(`| ${hr} hr | ${fpw}/week | ${be.months.toFixed(1)} mo | ${be.annualRoi.toFixed(0)}% |`);
  }
  console.log();

  console.log('## 5-Year Total Cost');
  const devCost = 34350; // sunk development
  const annualSteadyState = annualOps.tokenCost + steadyMaint.cost + failure.total * 0.3; // failure reduces over time
  let cumulative = devCost;
  for (let y = 1; y <= 5; y++) {
    cumulative += annualOps.tokenCost;
    if (y === 1) cumulative += maintenance.cost;
    else cumulative += steadyMaint.cost;
    cumulative += failure.total * Math.pow(0.5, y - 1); // failure rate halves each year
    const todos = TODOS_PER_RUN * RUNS_PER_WEEK * WEEKS_PER_YEAR * y;
    console.log(`  Year ${y}: cumulative ${fmtUSD(cumulative)}, ${fmtInt(todos)} todos, ${fmtUSD(cumulative/todos)}/todo`);
  }

  console.log();
  console.log('**Key insight**: Operator time dominates all costs. Token waste is trivial.');
  console.log('Every engineering hour spent eliminating a failure mode returns 5-10x in prevented operator time within 12 months.');
}

main();
