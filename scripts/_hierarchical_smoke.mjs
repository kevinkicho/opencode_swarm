#!/usr/bin/env node
// Smoke tests for the 5 hierarchical patterns shipped 2026-04-23.
// Each pattern test: POST a run with that pattern + minimal valid
// config, wait ~60 s, verify the pattern's signature behavior kicked
// off (sessions spawned, expected first-activity signal observable),
// stop the ticker, report PASS / FAIL.
//
// Not a full end-to-end validation — these SMOKES confirm "the run
// POST is accepted, the pattern's kickoff code runs without throwing,
// and the first observable signal lands within the smoke window."
// Real patterns are validated by running them against a real repo.
//
// Usage:
//   node scripts/_hierarchical_smoke.mjs                # all 5 patterns
//   node scripts/_hierarchical_smoke.mjs critic-loop    # one pattern
//   node scripts/_hierarchical_smoke.mjs --origin http://localhost:49187 role-differentiated
//
// Assumptions:
//   - Dev server reachable at --origin (default http://localhost:49187)
//   - opencode backend reachable (via the app's proxy — we don't hit it directly)
//   - A valid cloned workspace exists at the path configured below
//
// Exit code: 0 if all requested patterns PASS, 1 if any FAIL or
// precheck fails.

const DEFAULT_ORIGIN = 'http://localhost:49187';
const DEFAULT_WORKSPACE = 'C:/Users/kevin/Workspace/kyahoofinance032926';
const DEFAULT_SOURCE = 'https://github.com/kevinkicho/kyahoofinance032926';

// How long to watch each run after POST before verdict. Different patterns
// have different "first observable signal" landing times — orchestrator-
// worker's planner sweep takes ~60-90 s, critic-loop's worker draft starts
// emitting tokens within ~15 s. 90 s is the ceiling that covers every
// pattern's first-signal window with margin.
const WATCH_MS = 90_000;
const POLL_MS = 5_000;

const ALL_PATTERNS = [
  'orchestrator-worker',
  'role-differentiated',
  'critic-loop',
  'debate-judge',
  'deliberate-execute',
];

// Minimal valid POST body per pattern. Directive is deliberately tiny
// ("echo OK") — smoke doesn't care what the agents actually produce,
// just that the orchestration kicks off. teamSize picks the minimum
// for each pattern so the smoke spawns the fewest opencode sessions
// necessary to exercise the code path.
function bodyFor(pattern, origin, workspace, source) {
  const base = {
    pattern,
    workspace,
    source,
    directive:
      'Smoke test — reply briefly so the orchestration can observe activity.',
  };
  switch (pattern) {
    case 'orchestrator-worker':
      return { ...base, teamSize: 2 }; // 1 orchestrator + 1 worker
    case 'role-differentiated':
      return { ...base, teamSize: 2, teamRoles: ['architect', 'builder'] };
    case 'critic-loop':
      return { ...base, teamSize: 2, criticMaxIterations: 1 };
    case 'debate-judge':
      return { ...base, teamSize: 3, debateMaxRounds: 1 }; // 1 judge + 2 generators
    case 'deliberate-execute':
      return { ...base, teamSize: 2 };
    default:
      return base;
  }
}

// What signal counts as "the pattern's kickoff fired successfully" for
// each pattern. Observable via the run's API without needing to open
// SSE. See the returned description for what the smoke is asserting.
function expectedSignal(pattern) {
  switch (pattern) {
    case 'orchestrator-worker':
      // Planner sweep lands on session 0 → board gets items seeded.
      return { kind: 'board-has-items', description: 'planner sweep seeded todos' };
    case 'role-differentiated':
      return { kind: 'board-has-items', description: 'architect seeded todos' };
    case 'critic-loop':
      // Worker starts producing tokens (no board — just activity).
      return { kind: 'tokens-growing', description: 'worker drafting' };
    case 'debate-judge':
      // Generators start producing — tokens begin growing across sessions.
      return { kind: 'tokens-growing', description: 'generators drafting' };
    case 'deliberate-execute':
      // Council round 1 — all sessions producing drafts, tokens grow.
      return { kind: 'tokens-growing', description: 'council round 1 drafting' };
    default:
      return { kind: 'tokens-growing', description: 'any activity' };
  }
}

async function postRun(origin, body) {
  const res = await fetch(`${origin}/api/swarm/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /api/swarm/run → ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`POST returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function getBoard(origin, runID) {
  try {
    const r = await fetch(`${origin}/api/swarm/run/${runID}/board`, { cache: 'no-store' });
    if (!r.ok) return { items: [] };
    return await r.json();
  } catch {
    return { items: [] };
  }
}

async function getRunMetrics(origin, runID) {
  try {
    const r = await fetch(`${origin}/api/swarm/run`, { cache: 'no-store' });
    if (!r.ok) return null;
    const { runs } = await r.json();
    return runs.find((row) => row.meta.swarmRunID === runID) ?? null;
  } catch {
    return null;
  }
}

async function stopTicker(origin, runID) {
  try {
    await fetch(`${origin}/api/swarm/run/${runID}/board/ticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
  } catch {
    // stop is best-effort; smoke already made its verdict
  }
}

function pad(s, n) {
  return String(s).padEnd(n);
}

async function smokeOne(origin, workspace, source, pattern) {
  const t0 = Date.now();
  const log = (msg) => {
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${String(sec).padStart(3)}s] ${msg}`);
  };
  console.log(`\n── ${pattern} ──`);

  // Step 1: POST.
  let launch;
  try {
    launch = await postRun(origin, bodyFor(pattern, origin, workspace, source));
  } catch (err) {
    console.log(`  FAIL on POST: ${err.message}`);
    return { pattern, verdict: 'FAIL', reason: `POST: ${err.message}` };
  }
  const runID = launch.swarmRunID;
  const sessionCount = launch.sessionIDs?.length ?? 0;
  log(`spawned: runID=${runID} sessions=${sessionCount}`);
  if (!runID || sessionCount === 0) {
    return { pattern, verdict: 'FAIL', reason: 'no runID or 0 sessions spawned' };
  }

  // Step 2: watch for the expected signal.
  const signal = expectedSignal(pattern);
  log(`watching for: ${signal.description} (${signal.kind})`);
  const deadline = Date.now() + WATCH_MS;
  let baselineTokens = 0;
  {
    const m = await getRunMetrics(origin, runID);
    baselineTokens = m?.tokensTotal ?? 0;
  }
  let verdict = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (signal.kind === 'board-has-items') {
      const board = await getBoard(origin, runID);
      const count = Array.isArray(board.items) ? board.items.length : 0;
      if (count > 0) {
        log(`PASS: board has ${count} items`);
        verdict = { pattern, verdict: 'PASS', reason: `board=${count}` };
        break;
      }
    } else if (signal.kind === 'tokens-growing') {
      const m = await getRunMetrics(origin, runID);
      const tokens = m?.tokensTotal ?? 0;
      if (tokens > baselineTokens) {
        log(`PASS: tokens=${tokens} (baseline=${baselineTokens})`);
        verdict = {
          pattern,
          verdict: 'PASS',
          reason: `tokens=${tokens} (+${tokens - baselineTokens})`,
        };
        break;
      }
    }
  }
  if (!verdict) {
    log(`FAIL: no signal within ${WATCH_MS / 1000}s`);
    verdict = {
      pattern,
      verdict: 'FAIL',
      reason: `no ${signal.kind} within ${WATCH_MS / 1000}s`,
    };
  }

  // Step 3: stop ticker (if it was started). Non-fatal.
  await stopTicker(origin, runID);
  log(`ticker stop requested`);
  verdict.runID = runID;
  return verdict;
}

async function precheck(origin) {
  try {
    const r = await fetch(`${origin}/api/swarm/run`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    console.error(`precheck FAIL: dev server at ${origin} not responding — ${err.message}`);
    return false;
  }
  return true;
}

async function main() {
  // Arg parse: --origin <url>, --workspace <path>, --source <url>, then pattern names.
  const args = process.argv.slice(2);
  let origin = DEFAULT_ORIGIN;
  let workspace = DEFAULT_WORKSPACE;
  let source = DEFAULT_SOURCE;
  const patterns = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--origin') origin = args[++i];
    else if (a === '--workspace') workspace = args[++i];
    else if (a === '--source') source = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/_hierarchical_smoke.mjs [--origin URL] [--workspace PATH] [--source URL] [pattern ...]');
      process.exit(0);
    } else patterns.push(a);
  }
  const selected = patterns.length > 0 ? patterns : ALL_PATTERNS;
  for (const p of selected) {
    if (!ALL_PATTERNS.includes(p)) {
      console.error(`unknown pattern: ${p}. valid: ${ALL_PATTERNS.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`hierarchical-patterns smoke`);
  console.log(`  origin:    ${origin}`);
  console.log(`  workspace: ${workspace}`);
  console.log(`  patterns:  ${selected.join(', ')}`);
  console.log(`  window:    ${WATCH_MS / 1000}s per pattern`);

  if (!(await precheck(origin))) process.exit(1);

  const results = [];
  for (const p of selected) {
    results.push(await smokeOne(origin, workspace, source, p));
  }

  console.log(`\n── summary ──`);
  for (const r of results) {
    const mark = r.verdict === 'PASS' ? '✓' : '✗';
    console.log(
      `  ${mark} ${pad(r.pattern, 22)} ${pad(r.verdict, 5)} ${r.reason}  [${r.runID ?? '-'}]`,
    );
  }
  const fails = results.filter((r) => r.verdict !== 'PASS').length;
  if (fails > 0) {
    console.log(`\n${fails} pattern(s) failed`);
    process.exit(1);
  }
  console.log(`\nall ${results.length} patterns passed`);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
