#!/usr/bin/env node
// Pattern validation smoke — task #70.
//
// Codifies today's manual workflow (spawn 8 patterns × 60min + monitor +
// diagnose) into a fast, scripted PASS/FAIL gate.
//
// Usage:
//   node scripts/_validate_all_patterns.mjs                          # all patterns
//   node scripts/_validate_all_patterns.mjs council critic-loop      # subset
//   BASE_URL=http://172.24.37.95:4097 node scripts/_validate_all_patterns.mjs
//
// Per pattern:
//   1. POST /api/swarm/run with a calibrated short directive.
//   2. Poll /api/swarm/run/:id/snapshot every 5s.
//   3. Until per-pattern timeout: check the success criterion.
//   4. Record PASS / FAIL / SKIP with detail.
//
// Success criteria:
//   blackboard / role-differentiated / orchestrator-worker
//     → snapshot.board.items has ≥ 1 with status='done'.
//   council / map-reduce / debate-judge / critic-loop
//     → ≥ 1 session has produced ≥ 1 completed assistant turn.
//   deliberate-execute
//     → both: council-phase assistants completed AND board.done≥1.
//
// Run cost target: ~$2-5 vs. today's ~$20-50 long-form validation.

import { existsSync, readFileSync } from 'node:fs';

const BASE_URL =
  process.env.BASE_URL ?? `http://127.0.0.1:${resolveDevPort()}`;
const WORKSPACE = process.env.WORKSPACE ?? process.cwd();

const ALL_PATTERNS = [
  'blackboard',
  'council',
  'map-reduce',
  'orchestrator-worker',
  'role-differentiated',
  'debate-judge',
  'critic-loop',
  'deliberate-execute',
];
const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const patterns = requested.length > 0 ? requested : ALL_PATTERNS;
const unknown = patterns.filter((p) => !ALL_PATTERNS.includes(p));
if (unknown.length > 0) {
  console.error(`Unknown pattern(s): ${unknown.join(', ')}`);
  console.error(`Valid: ${ALL_PATTERNS.join(', ')}`);
  process.exit(1);
}

// Per-pattern timeout (ms). Generous ceiling; success usually fires sooner
// and we exit early once the criterion is met. The 5min target in #70 is
// AVERAGE — a slow ollama load or queue-routing miss can push individuals
// to ~10min on a cold daemon, hence the 12min ceiling.
const PATTERN_TIMEOUT_MS = 12 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;

// Short calibrated directives — ~5min of useful work each. Wording is
// pattern-shape-aware so the success criterion can fire (e.g. critic-loop
// needs a draftable subject; map-reduce needs a splittable surface).
const DIRECTIVES = {
  blackboard: 'Look around lib/server/, write 2-3 short notes about what you find.',
  council: 'Each member: in 2 short paragraphs, propose one improvement to lib/server/swarm-bounds.ts. Disagreement is fine.',
  'map-reduce': 'Split the lib/blackboard/ folder across mappers; each summarizes their slice in one paragraph; reducer combines into a one-page overview.',
  'orchestrator-worker': 'Plan and execute: skim 3 files in lib/server/blackboard/, then write a single short summary file explaining what you found.',
  'role-differentiated': 'Roles: one architect surveys, one writer documents. Pick lib/server/swarm-bounds.ts — architect proposes one improvement; writer drafts a short note.',
  'debate-judge': 'Topic: should non-ticker patterns enforce wall-clock caps with the same 60min default as today, or pattern-specific defaults? Generators argue both sides; judge picks.',
  'critic-loop': 'Worker: write a one-paragraph summary of lib/server/swarm-bounds.ts. Critic: review for accuracy and concision.',
  'deliberate-execute': 'Deliberate: what is one tiny improvement to README.md? Then execute: make that improvement.',
};

function resolveDevPort() {
  if (existsSync('.dev-port')) {
    return readFileSync('.dev-port', 'utf8').trim();
  }
  return '49187';
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} → HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json();
}

function fmtMs(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

async function spawnRun(pattern) {
  const body = {
    pattern,
    workspace: WORKSPACE,
    directive: DIRECTIVES[pattern],
    title: `validate ${pattern}`,
    bounds: { minutesCap: 12 }, // align with PATTERN_TIMEOUT_MS
  };
  const start = Date.now();
  const result = await fetchJSON(`${BASE_URL}/api/swarm/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!result.swarmRunID) {
    throw new Error(`spawn failed: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { swarmRunID: result.swarmRunID, spawnedAtMs: start };
}

async function snapshot(swarmRunID) {
  return fetchJSON(`${BASE_URL}/api/swarm/run/${swarmRunID}/snapshot`);
}

function checkBoardDone(snap) {
  return (snap.board?.items ?? []).filter((i) => i.status === 'done').length;
}

async function checkAssistantTurns(snap, swarmRunID) {
  // The snapshot doesn't include per-message timing, so we hit the
  // proxy directly for each session. Cheap — 1 round trip per session.
  const sessionIDs = snap.meta?.sessionIDs ?? [];
  const directory = encodeURIComponent(snap.meta?.workspace ?? WORKSPACE);
  let total = 0;
  for (const sid of sessionIDs) {
    try {
      const messages = await fetchJSON(
        `${BASE_URL}/api/opencode/session/${encodeURIComponent(sid)}/message?directory=${directory}`,
      );
      if (!Array.isArray(messages)) continue;
      total += messages.filter(
        (m) => m.info?.role === 'assistant' && m.info.time?.completed,
      ).length;
    } catch {
      // Session fetch failed — count as zero, don't fail the run.
    }
  }
  return total;
}

async function abortRun(swarmRunID, snap) {
  // Best-effort cleanup. We can't actually delete the run via API
  // (intentionally — see retention policy), but we can stop the ticker
  // for tickered patterns so the run doesn't keep spending after we
  // record success. For non-ticker patterns the orchestrator returns
  // on its own; nothing to do.
  if (snap?.ticker?.state === 'active') {
    try {
      await fetch(
        `${BASE_URL}/api/swarm/run/${swarmRunID}/board/ticker`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop' }),
        },
      );
    } catch {
      // Ignore — we're already done with this run.
    }
  }
}

async function validatePattern(pattern) {
  console.log(`\n── ${pattern} ──`);
  const t0 = Date.now();
  let swarmRunID = '';
  try {
    const spawned = await spawnRun(pattern);
    swarmRunID = spawned.swarmRunID;
    console.log(`  spawned ${swarmRunID}`);

    const deadline = t0 + PATTERN_TIMEOUT_MS;
    let lastSnap = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        lastSnap = await snapshot(swarmRunID);
      } catch (err) {
        console.warn(`  poll failed: ${err.message}`);
        continue;
      }

      const isBoardPattern =
        pattern === 'blackboard' ||
        pattern === 'role-differentiated' ||
        pattern === 'orchestrator-worker';
      const isAssistantPattern =
        pattern === 'council' ||
        pattern === 'map-reduce' ||
        pattern === 'debate-judge' ||
        pattern === 'critic-loop';
      const isDeliberateExecute = pattern === 'deliberate-execute';

      if (isBoardPattern) {
        const doneCount = checkBoardDone(lastSnap);
        if (doneCount >= 1) {
          await abortRun(swarmRunID, lastSnap);
          return {
            pattern,
            status: 'pass',
            elapsed: Date.now() - t0,
            detail: `board.done=${doneCount} after ${fmtMs(Date.now() - t0)}`,
            swarmRunID,
          };
        }
      } else if (isAssistantPattern) {
        const turns = await checkAssistantTurns(lastSnap, swarmRunID);
        if (turns >= 1) {
          await abortRun(swarmRunID, lastSnap);
          return {
            pattern,
            status: 'pass',
            elapsed: Date.now() - t0,
            detail: `assistant turns=${turns} after ${fmtMs(Date.now() - t0)}`,
            swarmRunID,
          };
        }
      } else if (isDeliberateExecute) {
        const turns = await checkAssistantTurns(lastSnap, swarmRunID);
        const doneCount = checkBoardDone(lastSnap);
        if (turns >= 2 && doneCount >= 1) {
          await abortRun(swarmRunID, lastSnap);
          return {
            pattern,
            status: 'pass',
            elapsed: Date.now() - t0,
            detail: `phases: assistants=${turns}, board.done=${doneCount} after ${fmtMs(Date.now() - t0)}`,
            swarmRunID,
          };
        }
      }
    }
    await abortRun(swarmRunID, lastSnap);
    return {
      pattern,
      status: 'fail',
      elapsed: Date.now() - t0,
      detail: `timeout after ${fmtMs(PATTERN_TIMEOUT_MS)} — criterion never met`,
      swarmRunID,
    };
  } catch (err) {
    return {
      pattern,
      status: 'fail',
      elapsed: Date.now() - t0,
      detail: `error: ${err.message}`,
      swarmRunID,
    };
  }
}

async function main() {
  console.log(`[validate-all-patterns] BASE_URL=${BASE_URL}`);
  console.log(`[validate-all-patterns] WORKSPACE=${WORKSPACE}`);
  console.log(`[validate-all-patterns] patterns=${patterns.join(', ')}`);

  const results = [];
  for (const p of patterns) {
    const r = await validatePattern(p);
    results.push(r);
    console.log(`  → ${r.status.toUpperCase()} — ${r.detail}`);
  }

  console.log('\n══ Summary ══');
  for (const r of results) {
    const tag =
      r.status === 'pass'
        ? 'PASS'
        : r.status === 'skip'
          ? 'SKIP'
          : 'FAIL';
    console.log(
      `  ${tag.padEnd(5, ' ')} ${r.pattern.padEnd(22, ' ')} ${fmtMs(r.elapsed).padStart(6, ' ')}  ${r.detail}`,
    );
    if (r.swarmRunID) {
      console.log(`        ${BASE_URL}/?swarmRun=${r.swarmRunID}`);
    }
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
