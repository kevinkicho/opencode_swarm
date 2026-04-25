#!/usr/bin/env node
// Per-agent latency disparity investigation — task #79.
//
// Usage:
//   node scripts/_latency_disparity.mjs <swarmRunID> [baseURL]
//
// Default baseURL: http://127.0.0.1:4097 (the dev server). Provide an
// alternate (e.g. http://172.24.37.95:<port>) when running against the
// WSL bridge from a Windows shell.
//
// Output: per-session turn statistics (count, median, p95 duration)
// plus a disparity summary that flags any session whose median turn
// duration is ≥ 2x the run's median. Read-only — does not perturb the
// run.
//
// Investigates ollama-swarm's open question: "why do some agents in
// serial presets take much longer than others?" Today's debate-fix
// run showed BtqU produced 10/9 turns while siblings stuck at 2/1 —
// a 5x disparity for nominally identical work. This script makes
// that disparity visible per-session so we can correlate with model,
// session position, agent role, etc.

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    'Usage: node scripts/_latency_disparity.mjs <swarmRunID> [baseURL]',
  );
  process.exit(1);
}
const [swarmRunID, baseURLArg] = args;
const baseURL = baseURLArg ?? 'http://127.0.0.1:4097';

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(nums, p) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function fmtMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GET ${url} → HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  console.log(`[latency-disparity] swarmRunID=${swarmRunID}`);
  console.log(`[latency-disparity] baseURL=${baseURL}`);

  const meta = await fetchJSON(`${baseURL}/api/swarm/run/${swarmRunID}`);
  if (!meta?.sessionIDs || !Array.isArray(meta.sessionIDs)) {
    console.error('Run meta missing sessionIDs — aborting');
    process.exit(1);
  }
  console.log(
    `[latency-disparity] run pattern=${meta.pattern} workspace=${meta.workspace}`,
  );
  console.log(
    `[latency-disparity] sessions=${meta.sessionIDs.length} models=${(meta.teamModels ?? []).join(',') || '(none pinned)'}`,
  );
  console.log('');

  const directory = encodeURIComponent(meta.workspace);
  const perSession = [];
  const allDurations = [];

  for (let i = 0; i < meta.sessionIDs.length; i += 1) {
    const sid = meta.sessionIDs[i];
    const messages = await fetchJSON(
      `${baseURL}/api/opencode/session/${encodeURIComponent(sid)}/message?directory=${directory}`,
    );
    if (!Array.isArray(messages)) {
      console.warn(`  session ${sid.slice(-8)}: no messages array — skipping`);
      continue;
    }
    const assistants = messages.filter((m) => m.info?.role === 'assistant');
    const completed = assistants.filter((m) => m.info.time?.completed);
    const durations = completed.map(
      (m) => m.info.time.completed - m.info.time.created,
    );
    const totalTokensIn = completed.reduce(
      (sum, m) => sum + (m.info.tokens?.input ?? 0),
      0,
    );
    const totalTokensOut = completed.reduce(
      (sum, m) => sum + (m.info.tokens?.output ?? 0),
      0,
    );
    const totalCost = completed.reduce((sum, m) => sum + (m.info.cost ?? 0), 0);
    const inFlight = assistants.length - completed.length;
    const errored = assistants.filter((m) => m.info.error).length;
    const modelID = completed[completed.length - 1]?.info.modelID ?? '(unknown)';
    perSession.push({
      sid,
      idx: i,
      modelID,
      turns: completed.length,
      inFlight,
      errored,
      durations,
      median: median(durations),
      p95: percentile(durations, 0.95),
      totalTokensIn,
      totalTokensOut,
      totalCost,
    });
    for (const d of durations) allDurations.push(d);
  }

  if (perSession.length === 0) {
    console.error('No sessions had readable messages — aborting');
    process.exit(1);
  }

  const runMedian = median(allDurations);

  // Per-session report.
  console.log('Per-session turn stats:');
  console.log(
    '  idx  sid          model                  turns  err  median   p95     tok_in    tok_out   cost',
  );
  for (const s of perSession) {
    const flag = s.median >= 2 * runMedian && runMedian > 0 ? '  *' : '';
    console.log(
      `  ${String(s.idx).padStart(2, ' ')}   ${s.sid.slice(-8)}     ${(s.modelID ?? '?').padEnd(22, ' ').slice(0, 22)} ${String(s.turns).padStart(4, ' ')}   ${String(s.errored).padStart(2, ' ')}   ${fmtMs(s.median).padStart(6, ' ')} ${fmtMs(s.p95).padStart(6, ' ')}  ${String(s.totalTokensIn).padStart(8, ' ')}  ${String(s.totalTokensOut).padStart(8, ' ')}  $${s.totalCost.toFixed(4)}${flag}`,
    );
  }

  console.log('');
  console.log(
    `Run median turn duration: ${fmtMs(runMedian)} (across ${allDurations.length} completed turns)`,
  );

  // Disparity summary.
  const turns = perSession.map((s) => s.turns);
  const minTurns = Math.min(...turns);
  const maxTurns = Math.max(...turns);
  const turnRatio = minTurns > 0 ? (maxTurns / minTurns).toFixed(1) : 'inf';
  console.log(`Turn-count range: ${minTurns}…${maxTurns} (${turnRatio}x)`);

  const flagged = perSession.filter(
    (s) => s.median >= 2 * runMedian && runMedian > 0,
  );
  if (flagged.length > 0) {
    console.log('');
    console.log(
      `WARN: ${flagged.length} session(s) have median turn duration ≥ 2x run median:`,
    );
    for (const s of flagged) {
      console.log(
        `  - session ${s.sid.slice(-8)} (idx ${s.idx}, model ${s.modelID}): median ${fmtMs(s.median)} vs run ${fmtMs(runMedian)} (${(s.median / runMedian).toFixed(1)}x)`,
      );
    }
  } else {
    console.log('');
    console.log(
      'No session flagged for high latency disparity (no median ≥ 2x run median).',
    );
  }

  console.log('');
  console.log(
    'Hypotheses to explore on a flagged session: (1) opencode session-state buildup (more tool-call iterations per turn, longer assembled context), (2) ollama queue-routing (model loaded later, behind another request), (3) per-session model-cold-start asymmetry (first turn slow, others fast). Compare flagged session\'s first-turn vs steady-state durations to differentiate.',
  );
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
