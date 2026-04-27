#!/usr/bin/env node
// Validation sweep — runs the 6 supported swarm patterns serially
// (per `feedback_live_runs_serial`), captures pattern-specific success
// signals, and emits a structured verdict per pattern + a final report.
//
// Per-pattern contract:
//   - directive shape that's known to exercise the pattern's path
//   - teamSize per the pattern's defaultSize
//   - runCapMin (bounds.minutesCap on the spawn)
//   - monitorCapSec (internal ceiling that overrides if the run runs
//     long; well under the user's 15-min ceiling)
//   - successSignals[] — checks polled against the snapshot + per-session
//     messages; each has a deadlineSec
//   - stuckSignals[] — early-bail conditions
//
// Verdict shape per run:
//   PASS — every successSignal fired within its deadline, terminal state clean
//   DEGRADED — some successSignals fired, others missed deadline; no crash
//   FAIL — stuckSignal triggered OR error sustained OR no first-tokens
//
// Output:
//   - line-buffered events on stdout (one per state change / signal /
//     verdict) so the Monitor tool can stream them as notifications
//   - final JSON report written to /tmp/ui-sweep-validation.json
//
// Usage: node scripts/_validation_sweep.mjs [pattern1,pattern2,...]
// Default: all 6 patterns.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const ALL_PATTERNS = [
  'blackboard',
  'council',
  'map-reduce',
  'orchestrator-worker',
  'debate-judge',
  'critic-loop',
];

const PATTERNS_TO_RUN = (process.argv[2] ?? '').trim()
  ? process.argv[2].split(',')
  : ALL_PATTERNS;

let port;
try {
  port = readFileSync('.dev-port', 'utf8').trim();
} catch {
  console.error('FATAL: .dev-port missing — start dev server first');
  process.exit(1);
}
const BASE = `http://localhost:${port}`;
const WORKSPACE = 'C:/Users/kevin/Workspace/kyahoofinance032926';
const WORKSPACE_QS = encodeURIComponent(WORKSPACE);

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function emit(level, kind, payload) {
  process.stdout.write(`[${ts()}][${level}][${kind}] ${payload}\n`);
}

// ─── Per-pattern contracts ────────────────────────────────────────────────

// Deadlines tightened 2026-04-27 per user "fail fast" feedback
// (was 120-360s; now ~30-180s based on observed healthy timings).
// Floor at 30s for first-tokens — sub-30s would fail legitimate
// healthy runs since even fast models take ~16-22s to start.
const CONTRACTS = {
  blackboard: {
    teamSize: 3,
    runCapMin: 5,
    monitorCapSec: 360,
    directive:
      'Briefly survey the README. Identify 3 concrete improvements; each agent claims one and posts a finding to the board. Stop after 3 findings.',
    successSignals: [
      { name: 'first-tokens', deadlineSec: 30, check: (s) => s.tokensTotal > 0 },
      { name: 'planner-output', deadlineSec: 120, check: (s) => s.planRevisions > 0 },
      { name: 'board-populated', deadlineSec: 180, check: (s) => s.itemsTotal > 0 },
      { name: 'first-done', deadlineSec: 300, check: (s) => s.doneCount > 0 },
    ],
  },
  council: {
    teamSize: 3,
    runCapMin: 3,
    monitorCapSec: 240,
    directive:
      'Briefly survey the README. Each member: argue for ONE concrete improvement. Convergence is fine after one round.',
    successSignals: [
      { name: 'first-tokens', deadlineSec: 30, check: (s) => s.tokensTotal > 0 },
      { name: 'r1-complete', deadlineSec: 90, check: (s) => s.allSessionsCompletedAssistants >= 1 },
      { name: 'r2-complete', deadlineSec: 150, check: (s) => s.allSessionsCompletedAssistants >= 2 },
      { name: 'r3-complete', deadlineSec: 210, check: (s) => s.allSessionsCompletedAssistants >= 3 },
    ],
  },
  'map-reduce': {
    teamSize: 3,
    runCapMin: 5,
    monitorCapSec: 300,
    directive:
      'Survey the README in 3 parallel slices (top, middle, bottom). Each mapper: extract ONE concrete improvement. Synth: combine into one final list.',
    successSignals: [
      { name: 'first-tokens', deadlineSec: 30, check: (s) => s.tokensTotal > 0 },
      { name: 'all-mappers-active', deadlineSec: 60, check: (s) => s.sessionsWithMessages >= 3 },
      { name: 'mapper-drafts-complete', deadlineSec: 240, check: (s) => s.allSessionsCompletedAssistants >= 1 },
    ],
  },
  'orchestrator-worker': {
    teamSize: 3,
    runCapMin: 5,
    monitorCapSec: 360,
    directive:
      'Briefly survey the README. Orchestrator: identify 2 concrete improvements and dispatch one each to two workers using the task tool. Stop after both workers report back.',
    successSignals: [
      { name: 'first-tokens', deadlineSec: 30, check: (s) => s.tokensTotal > 0 },
      // session 0 = orchestrator; expect a `task` tool call within 90s
      // (Q34 shape — orchestrator stuck without dispatching is the
      // canonical failure mode for this pattern). Was 180s; tightened
      // 2026-04-27. Healthy orchestrators dispatch within 30-60s.
      { name: 'orchestrator-dispatches-task', deadlineSec: 90, check: (s) => s.toolCallsBySession[0]?.task > 0 },
      { name: 'workers-receive-prompts', deadlineSec: 150, check: (s) => s.sessionsWithMessages >= 2 },
    ],
  },
  'debate-judge': {
    teamSize: 3,
    runCapMin: 4,
    monitorCapSec: 240,
    directive:
      'Briefly survey the README. Two generators: each propose ONE concrete improvement. Judge: pick the strongest with WINNER: <id>.',
    successSignals: [
      { name: 'first-tokens', deadlineSec: 30, check: (s) => s.tokensTotal > 0 },
      { name: 'all-sessions-active', deadlineSec: 60, check: (s) => s.sessionsWithMessages >= 3 },
      { name: 'all-drafts-complete', deadlineSec: 180, check: (s) => s.allSessionsCompletedAssistants >= 1 },
    ],
  },
  'critic-loop': {
    teamSize: 2,
    runCapMin: 5,
    monitorCapSec: 240,
    directive:
      'Briefly survey the README. Worker: propose ONE concrete improvement. Critic: review and respond with APPROVED: <reason> or REVISE: <reason>.',
    successSignals: [
      { name: 'first-tokens', deadlineSec: 30, check: (s) => s.tokensTotal > 0 },
      { name: 'worker-draft', deadlineSec: 90, check: (s) => s.allSessionsCompletedAssistants >= 1 },
      { name: 'critic-active', deadlineSec: 120, check: (s) => s.sessionsWithMessages >= 2 },
    ],
  },
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) {
    return { __error: `HTTP ${res.status}` };
  }
  return res.json();
}

async function spawn(pattern) {
  const c = CONTRACTS[pattern];
  const body = {
    pattern,
    workspace: WORKSPACE,
    directive: c.directive,
    teamSize: c.teamSize,
    bounds: { minutesCap: c.runCapMin },
  };
  const res = await fetch(`${BASE}/api/swarm/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`spawn failed: ${json.error}`);
  }
  return { runID: json.swarmRunID, sessionIDs: json.sessionIDs ?? [] };
}

async function stopRun(runID) {
  try {
    await fetch(`${BASE}/api/swarm/run/${runID}/stop`, { method: 'POST' });
  } catch (err) {
    emit('WARN', 'STOP', `stop failed: ${err.message?.slice(0, 100)}`);
  }
}

// ─── Per-session probe ────────────────────────────────────────────────────
// Returns: { msgCount, completedAssistantCount, toolCalls: { read: N, task: N, ... } }

async function probeSession(sid) {
  const res = await fetch(
    `${BASE}/api/opencode/session/${sid}/message?directory=${WORKSPACE_QS}`,
    { cache: 'no-store' },
  );
  if (!res.ok) return { msgCount: 0, completedAssistantCount: 0, toolCalls: {} };
  const messages = await res.json();
  if (!Array.isArray(messages)) return { msgCount: 0, completedAssistantCount: 0, toolCalls: {} };
  let completedAssistantCount = 0;
  const toolCalls = {};
  for (const m of messages) {
    const info = m.info ?? {};
    if (info.role === 'assistant' && info.time?.completed) completedAssistantCount++;
    for (const part of m.parts ?? []) {
      if (part.type === 'tool' && part.toolName) {
        toolCalls[part.toolName] = (toolCalls[part.toolName] ?? 0) + 1;
      }
    }
  }
  return {
    msgCount: messages.length,
    completedAssistantCount,
    toolCalls,
  };
}

// ─── Run + monitor one pattern ────────────────────────────────────────────

async function runPattern(pattern) {
  const c = CONTRACTS[pattern];
  emit('INFO', 'PATTERN', `starting ${pattern} · teamSize=${c.teamSize} · runCap=${c.runCapMin}min · monitorCap=${c.monitorCapSec}s`);

  let runID, sessionIDs;
  try {
    const out = await spawn(pattern);
    runID = out.runID;
    sessionIDs = out.sessionIDs;
    emit('INFO', 'SPAWN', `${pattern} runID=${runID} sessions=${sessionIDs.length}`);
  } catch (err) {
    emit('FAIL', 'SPAWN', `${pattern}: ${err.message}`);
    return { pattern, verdict: 'FAIL', reason: 'spawn-failed', error: err.message };
  }

  const startMs = Date.now();
  const elapsed = () => Math.round((Date.now() - startMs) / 1000);

  const signalState = Object.fromEntries(
    c.successSignals.map((s) => [s.name, { fired: false, firedAtSec: null }]),
  );
  let firstTokenSec = null;
  let lastTokens = 0;
  let lastTokenChangeSec = 0;
  const tokenStagnationSec = 180;
  let consecutiveErrorPolls = 0;
  let lastStatus = null;
  let bailReason = null;

  const POLL_INTERVAL_MS = 15_000;

  while (true) {
    const t = elapsed();

    // ─── Snapshot + row ────────────────────────────────────────────────
    const snap = await fetchJson(`/api/swarm/run/${runID}/snapshot`);
    const list = await fetchJson(`/api/swarm/run`);
    if (snap.__error || list.__error) {
      consecutiveErrorPolls++;
      emit('WARN', 'POLL', `error: ${snap.__error ?? list.__error} (consec=${consecutiveErrorPolls})`);
      if (consecutiveErrorPolls >= 4) {
        bailReason = 'sustained-5xx';
        break;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    consecutiveErrorPolls = 0;
    const row = (list.runs ?? []).find((r) => r.meta?.swarmRunID === runID);

    // ─── Per-session probe (parallel) ──────────────────────────────────
    const sessionProbes = await Promise.all(sessionIDs.map(probeSession));

    // ─── Build state object for signal checks ─────────────────────────
    // Note distinction:
    //   msgCount = total messages (user + assistant, completed or not)
    //   completedAssistantCount = only fully-completed assistant turns
    // The latter is the honest signal for "round N complete" — earlier
    // contracts that used msgCount fired prematurely on user-prompt +
    // in-progress-assistant. Tightened 2026-04-27.
    const allSessionsMsgCount = Math.min(...sessionProbes.map((p) => p.msgCount), Infinity);
    const allSessionsCompletedAssistants = Math.min(...sessionProbes.map((p) => p.completedAssistantCount), Infinity);
    const sessionsWithMessages = sessionProbes.filter((p) => p.msgCount > 0).length;
    const toolCallsBySession = sessionProbes.map((p) => p.toolCalls);
    const items = snap.board?.items ?? snap.items ?? [];
    const doneCount = items.filter((i) => i.status === 'done').length;
    const errorCount = items.filter((i) => i.status === 'error').length;
    const planRevisions =
      typeof snap.planRevisions === 'object' && snap.planRevisions !== null
        ? snap.planRevisions.count ?? 0
        : Array.isArray(snap.planRevisions) ? snap.planRevisions.length : 0;

    const state = {
      tokensTotal: row?.tokensTotal ?? snap.derivedRow?.tokensTotal ?? 0,
      planRevisions,
      itemsTotal: items.length,
      doneCount,
      errorCount,
      allSessionsMsgCount: allSessionsMsgCount === Infinity ? 0 : allSessionsMsgCount,
      allSessionsCompletedAssistants: allSessionsCompletedAssistants === Infinity ? 0 : allSessionsCompletedAssistants,
      sessionsWithMessages,
      toolCallsBySession,
    };

    // ─── Status transition ─────────────────────────────────────────────
    const status = row?.status ?? snap.status ?? 'unknown';
    if (status !== lastStatus) {
      emit('INFO', 'STATUS', `${pattern}: ${lastStatus ?? 'init'} → ${status} @ ${t}s`);
      lastStatus = status;
    }

    // ─── First-tokens ──────────────────────────────────────────────────
    if (firstTokenSec === null && state.tokensTotal > 0) {
      firstTokenSec = t;
      emit('INFO', 'TOKENS', `${pattern}: first tokens @ ${t}s (${state.tokensTotal})`);
    }
    if (state.tokensTotal !== lastTokens) {
      lastTokens = state.tokensTotal;
      lastTokenChangeSec = t;
    }

    // ─── Success-signal checks ─────────────────────────────────────────
    for (const sig of c.successSignals) {
      if (signalState[sig.name].fired) continue;
      if (sig.check(state)) {
        signalState[sig.name].fired = true;
        signalState[sig.name].firedAtSec = t;
        emit('INFO', 'SIGNAL', `${pattern}: ✓ ${sig.name} @ ${t}s (deadline ${sig.deadlineSec}s)`);
      }
    }

    // ─── Stuck signals (bail conditions) ───────────────────────────────
    // 1. No first tokens past deadline (180s)
    if (firstTokenSec === null && t > 180) {
      bailReason = 'no-first-tokens';
      break;
    }
    // 2. Token stagnation: had first tokens, then no change for 180s
    if (firstTokenSec !== null && t - lastTokenChangeSec > tokenStagnationSec) {
      bailReason = `token-stagnation-${tokenStagnationSec}s`;
      break;
    }
    // 3. Status=error sustained
    if (status === 'error') {
      bailReason = 'status-error';
      break;
    }
    // 4. Item-error spike (>0 errors)
    if (state.errorCount > 0) {
      emit('WARN', 'ERRORS', `${pattern}: ${state.errorCount} item errors`);
      // Don't bail on item errors alone — pattern may recover
    }
    // 5. Terminal state — stale or all-done
    if (status === 'stale' && firstTokenSec !== null) {
      emit('INFO', 'TERMINAL', `${pattern}: status=stale @ ${t}s`);
      break;
    }
    // 6. Hard cap
    if (t > c.monitorCapSec) {
      bailReason = `hard-cap-${c.monitorCapSec}s`;
      break;
    }

    // ─── Early-success: all signals fired ──────────────────────────────
    const allFired = c.successSignals.every((s) => signalState[s.name].fired);
    if (allFired) {
      emit('INFO', 'COMPLETE', `${pattern}: all success signals fired @ ${t}s`);
      break;
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // ─── Stop run cleanly ──────────────────────────────────────────────────
  await stopRun(runID);
  emit('INFO', 'STOP', `${pattern}: stop dispatched`);

  // ─── Compute verdict ───────────────────────────────────────────────────
  const firedCount = c.successSignals.filter((s) => signalState[s.name].fired).length;
  const totalSignals = c.successSignals.length;
  const allFired = firedCount === totalSignals;
  let verdict;
  if (bailReason && !allFired) {
    verdict = 'FAIL';
  } else if (allFired && !bailReason) {
    verdict = 'PASS';
  } else if (firedCount >= Math.ceil(totalSignals / 2)) {
    verdict = 'DEGRADED';
  } else {
    verdict = 'FAIL';
  }

  const result = {
    pattern,
    runID,
    verdict,
    bailReason,
    elapsedSec: elapsed(),
    firstTokenSec,
    finalTokens: lastTokens,
    signalsFired: firedCount,
    signalsTotal: totalSignals,
    signalDetail: signalState,
  };
  emit(
    verdict === 'PASS' ? 'DONE' : verdict === 'DEGRADED' ? 'WARN' : 'FAIL',
    'VERDICT',
    `${pattern}: ${verdict} · signals ${firedCount}/${totalSignals} · ${result.elapsedSec}s · firstTokens=${firstTokenSec ?? 'never'}s · bail=${bailReason ?? 'none'}`,
  );
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  emit('INFO', 'SWEEP', `armed @ ${BASE} · patterns=[${PATTERNS_TO_RUN.join(',')}]`);
  const results = [];
  for (const p of PATTERNS_TO_RUN) {
    if (!CONTRACTS[p]) {
      emit('FAIL', 'CONFIG', `unknown pattern: ${p}`);
      results.push({ pattern: p, verdict: 'FAIL', reason: 'unknown-pattern' });
      continue;
    }
    try {
      const r = await runPattern(p);
      results.push(r);
    } catch (err) {
      emit('FAIL', 'CRASH', `${p}: ${err.message?.slice(0, 200)}`);
      results.push({ pattern: p, verdict: 'FAIL', reason: 'crash', error: err.message });
    }
  }
  const totalSec = Math.round((Date.now() - startedAt) / 1000);
  const passes = results.filter((r) => r.verdict === 'PASS').length;
  const degraded = results.filter((r) => r.verdict === 'DEGRADED').length;
  const fails = results.filter((r) => r.verdict === 'FAIL').length;
  emit(
    fails === 0 ? 'DONE' : 'WARN',
    'FINAL',
    `sweep complete · ${passes} PASS · ${degraded} DEGRADED · ${fails} FAIL · total ${totalSec}s`,
  );
  writeFileSync('/tmp/ui-sweep-validation.json', JSON.stringify({
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    totalSec,
    summary: { pass: passes, degraded, fail: fails },
    results,
  }, null, 2));
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  emit('FAIL', 'CRASH', `sweep crashed: ${err.message?.slice(0, 200)}`);
  process.exit(1);
});
