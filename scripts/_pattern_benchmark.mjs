#!/usr/bin/env node
// Pattern benchmark — runs the coordinator-backed blackboard-family
// patterns sequentially against the same workspace + directive and
// reports per-pattern metrics (tokens / cost / commits / done+stale
// ratio / wall clock). Produces a comparison table at the end.
//
// Why this exists: we ship 9 orchestration patterns but only blackboard
// has been empirically exercised at scale. This script answers "for
// a repo at this maturity, which pattern produces the best next
// increment?" by letting each pattern run against the live state left
// by the prior pattern — *not* a fresh sandbox. That matches the
// user's stated workspace-accumulation preference (see
// feedback_workspace_accumulation.md in memory).
//
// What it does NOT do:
//   - Clone into fresh folders between runs (defeats accumulation)
//   - Run patterns in parallel (would oversubscribe opencode sessions
//     and make per-pattern $/token accounting impossible)
//   - Run council / debate-judge / critic-loop (different shape —
//     those are about deliberation quality, not execution throughput,
//     so they wouldn't compare fairly on commits-landed metrics)
//
// Usage:
//   node scripts/_pattern_benchmark.mjs \
//     --workspace "C:/Users/kevin/Workspace/kyahoofinance032926" \
//     --directive "Improve this project meaningfully..." \
//     [--patterns blackboard,orchestrator-worker,role-differentiated] \
//     [--max-done 6] \
//     [--max-minutes 15] \
//     [--enable-critic-gate] \
//     [--origin http://localhost:49187]
//
// Assumes:
//   - Dev server is running and serving /api/swarm/run
//   - Opencode is up and routing via opencode-go/ prefix (see
//     feedback_zen_model_preference.md)
//   - The workspace is a git repo (commits are one of the metrics)

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i === args.length - 1) return def;
  return args[i + 1];
}
function argFlag(name) {
  return args.includes(`--${name}`);
}

const WORKSPACE = argVal(
  'workspace',
  'C:/Users/kevin/Workspace/kyahoofinance032926',
);
const DIRECTIVE = argVal(
  'directive',
  'Improve this project meaningfully. Use the README as the source of truth for what the project claims to be; identify gaps between claim and reality, and close them. Prefer substantive work — shipped features, real bug fixes, real-world tests — over polish / rearranging.',
);
const PATTERNS = argVal(
  'patterns',
  'blackboard,orchestrator-worker,role-differentiated',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_DONE = parseInt(argVal('max-done', '6'), 10);
const MAX_MINUTES = parseInt(argVal('max-minutes', '15'), 10);
const ENABLE_CRITIC = argFlag('enable-critic-gate');
const ORIGIN = argVal('origin', 'http://localhost:49187');

// Pattern → defaults we know work well. Keep in sync with
// PATTERN_TEAM_SIZE in app/api/swarm/run/route.ts — picking the default
// teamSize per pattern so one pattern doesn't get an unfair headcount.
const PATTERN_CONFIG = {
  blackboard: { teamSize: 3 },
  'orchestrator-worker': { teamSize: 4 },
  'role-differentiated': { teamSize: 4 },
};

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${opts.method ?? 'GET'} ${url} → HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

function workspaceLinuxPath(ws) {
  // Translate C:/foo/bar → /mnt/c/foo/bar for git commands under WSL.
  const m = ws.match(/^([A-Za-z]):[/\\](.*)$/);
  if (!m) return ws;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function gitHead(wsLinux) {
  try {
    return execSync(`git -C "${wsLinux}" rev-parse HEAD`, {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function gitCommitsSince(wsLinux, baseSha) {
  if (!baseSha) return [];
  try {
    const raw = execSync(
      `git -C "${wsLinux}" log --oneline ${baseSha}..HEAD`,
      { encoding: 'utf8' },
    ).trim();
    if (!raw) return [];
    return raw.split('\n');
  } catch {
    return [];
  }
}

// Run one pattern to a bounded terminal state. Returns metrics.
async function runOnePattern(pattern, baseSha) {
  const cfg = PATTERN_CONFIG[pattern];
  if (!cfg) throw new Error(`no config for pattern '${pattern}'`);

  const body = {
    pattern,
    workspace: WORKSPACE,
    directive: DIRECTIVE,
    teamSize: cfg.teamSize,
    persistentSweepMinutes: 0,
    enableCriticGate: ENABLE_CRITIC,
  };
  console.log(`\n── ${pattern} (teamSize=${cfg.teamSize}, criticGate=${ENABLE_CRITIC}) ──`);
  console.log('  firing…');

  const created = await fetchJson(`${ORIGIN}/api/swarm/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const runID = created.swarmRunID;
  const startMs = Date.now();
  console.log(`  swarmRunID=${runID}`);

  // Poll until one of the terminal conditions hits.
  const deadlineMs = startMs + MAX_MINUTES * 60 * 1000;
  let lastSummary = '';
  while (true) {
    await new Promise((r) => setTimeout(r, 15_000));
    const [board, tokens, ticker] = await Promise.all([
      fetchJson(`${ORIGIN}/api/swarm/run/${runID}/board`).catch(() => ({ items: [] })),
      fetchJson(`${ORIGIN}/api/swarm/run/${runID}/tokens`).catch(() => ({ totals: { tokens: 0, cost: 0 } })),
      fetchJson(`${ORIGIN}/api/swarm/run/${runID}/board/ticker`).catch(() => ({ state: 'none' })),
    ]);
    const items = board.items ?? [];
    const by = {};
    for (const i of items) by[i.status] = (by[i.status] ?? 0) + 1;
    const done = by.done ?? 0;
    const stale = by.stale ?? 0;
    const inProgress = by['in-progress'] ?? 0;
    const now = Date.now();
    const elapsedSec = Math.round((now - startMs) / 1000);
    const summary = `[${elapsedSec}s] done:${done} in-progress:${inProgress} stale:${stale} open:${by.open ?? 0} · tok:${tokens.totals.tokens.toLocaleString()} · ticker:${ticker.state}`;
    if (summary !== lastSummary) {
      console.log(`  ${summary}`);
      lastSummary = summary;
    }
    const tickerStopped = ticker.state === 'stopped';
    const hitDone = done >= MAX_DONE;
    const hitDeadline = now >= deadlineMs;
    if (tickerStopped || hitDone || hitDeadline) {
      const reason = tickerStopped
        ? `ticker-stopped (${ticker.stopReason ?? '?'})`
        : hitDone
          ? `max-done=${MAX_DONE} reached`
          : `max-minutes=${MAX_MINUTES} elapsed`;
      console.log(`  terminal: ${reason}`);
      // Ensure we clean up — stop the ticker so sessions get auto-
      // aborted via stopAutoTicker's session-abort hook.
      if (!tickerStopped) {
        await fetch(`${ORIGIN}/api/swarm/run/${runID}/board/ticker`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
        }).catch(() => undefined);
      }
      const wsLinux = workspaceLinuxPath(WORKSPACE);
      const endSha = gitHead(wsLinux);
      const commits = gitCommitsSince(wsLinux, baseSha);
      return {
        pattern,
        swarmRunID: runID,
        wallSec: Math.round((Date.now() - startMs) / 1000),
        tokens: tokens.totals.tokens,
        cost: tokens.totals.cost,
        done,
        stale,
        total: items.length,
        criticRejected: items.filter((i) => (i.note || '').includes('critic-rejected')).length,
        verifierRejected: items.filter((i) => (i.note || '').includes('verifier-rejected')).length,
        commits,
        endSha,
        terminalReason: reason,
      };
    }
  }
}

async function main() {
  console.log('Pattern benchmark');
  console.log(`  workspace:  ${WORKSPACE}`);
  console.log(`  directive:  ${DIRECTIVE.slice(0, 80)}${DIRECTIVE.length > 80 ? '…' : ''}`);
  console.log(`  patterns:   ${PATTERNS.join(', ')}`);
  console.log(`  max-done:   ${MAX_DONE}`);
  console.log(`  max-min:    ${MAX_MINUTES}`);
  console.log(`  criticGate: ${ENABLE_CRITIC}`);
  console.log(`  origin:     ${ORIGIN}`);

  const wsLinux = workspaceLinuxPath(WORKSPACE);
  const initialSha = gitHead(wsLinux);
  console.log(`\n  workspace HEAD @ start: ${initialSha ?? '(not a git repo)'}`);

  const results = [];
  let runningSha = initialSha;
  for (const pattern of PATTERNS) {
    try {
      const r = await runOnePattern(pattern, runningSha);
      results.push(r);
      runningSha = r.endSha; // next pattern measures commits since THIS pattern's end
    } catch (err) {
      console.log(`  ERROR on ${pattern}: ${err.message}`);
      results.push({
        pattern,
        error: err.message,
      });
    }
  }

  console.log('\n── comparison ──');
  console.log(
    '  pattern                 | wall  | tokens       | cost    | done | stale | critic-rej | verifier-rej | commits',
  );
  console.log(
    '  ------------------------|-------|--------------|---------|------|-------|------------|--------------|--------',
  );
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.pattern.padEnd(23)} | ERROR: ${r.error.slice(0, 100)}`);
      continue;
    }
    console.log(
      `  ${r.pattern.padEnd(23)} | ${String(r.wallSec + 's').padEnd(5)} | ${r.tokens.toLocaleString().padStart(12)} | $${r.cost.toFixed(3).padStart(6)} | ${String(r.done).padStart(4)} | ${String(r.stale).padStart(5)} | ${String(r.criticRejected).padStart(10)} | ${String(r.verifierRejected).padStart(12)} | ${r.commits.length}`,
    );
  }

  console.log('\n── commits landed per pattern ──');
  for (const r of results) {
    if (r.error || !r.commits?.length) continue;
    console.log(`  ${r.pattern}:`);
    for (const c of r.commits) console.log(`    ${c}`);
  }

  const totalTokens = results.reduce((s, r) => s + (r.tokens ?? 0), 0);
  const totalCost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
  const totalCommits = results.reduce((s, r) => s + (r.commits?.length ?? 0), 0);
  console.log(`\n  totals: ${totalTokens.toLocaleString()} tokens, $${totalCost.toFixed(3)}, ${totalCommits} commits`);

  const jsonPath = `/tmp/pattern-benchmark-${Date.now()}.json`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`  full JSON: ${jsonPath}`);
}

main().catch((err) => {
  console.error('benchmark crashed:', err);
  process.exit(1);
});
