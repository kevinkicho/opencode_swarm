#!/usr/bin/env node
// Audit which view-tabs (main viewport) and which left-panel tabs are
// visible for each of the 7 swarm patterns. Visits one canonical run
// per pattern, captures the actually-rendered tab labels, and prints
// a verification matrix.
//
// Source of truth on the code side:
//   - main view-tabs:    app/page.tsx  VIEW_PATTERN_GATES
//   - left-panel tabs:   components/left-tabs.tsx (plan/roster/board/heat)
//
// What we expect (from VIEW_PATTERN_GATES):
//   - timeline / chat / cards: every pattern
//   - board / contracts:       any pattern that has a boardSwarmRunID
//   - iterations:              critic-loop only
//   - debate:                  debate-judge only
//   - map:                     map-reduce only
//   - council:                 council only
//   - strategy:                orchestrator-worker only
// And on the left side (left-tabs.tsx):
//   - plan / roster:           always
//   - board:                   when boardSwarmRunID present
//   - heat:                    when ≥1 file has been touched

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const port = Number(readFileSync('.dev-port', 'utf8').trim());
const BASE = `http://127.0.0.1:${port}`;

const RUNS = {
  'none':                'run_moiyk0tx_zv2d6e',
  'blackboard':          'run_moistttk_ny55s6',
  'map-reduce':          'run_mohzzh1i_op1hxa',
  'council':             'run_moi14fqx_n73fln',
  'orchestrator-worker': 'run_moi1u8yl_pusb3r',
  'debate-judge':        'run_moi0f86g_9ggo8i',
  'critic-loop':         'run_moi0bi8b_7twudu',
};

// What the code says SHOULD be true.
//
// Two layers of gating in app/page.tsx:
//   - VIEW_PATTERN_GATES (lines 176-217) determines which TABS exist
//   - boardPatterns (lines 485-491) limits which patterns get a board:
//       blackboard, orchestrator-worker — those gain board + contracts
//       all other patterns: no board → board/contracts tabs hidden
//
// Pattern-specific tabs gate only on `pattern === 'X'`:
//   iterations  ← critic-loop
//   debate      ← debate-judge
//   map         ← map-reduce
//   council     ← council
//   strategy    ← orchestrator-worker
const EXPECTED_VIEW_TABS = {
  'none':                ['timeline', 'chat', 'cards'],
  'blackboard':          ['timeline', 'chat', 'cards', 'board', 'contracts'],
  'map-reduce':          ['timeline', 'chat', 'cards', 'map'],
  'council':             ['timeline', 'chat', 'cards', 'council'],
  'orchestrator-worker': ['timeline', 'chat', 'cards', 'board', 'contracts', 'strategy'],
  'debate-judge':        ['timeline', 'chat', 'cards', 'debate'],
  'critic-loop':         ['timeline', 'chat', 'cards', 'iterations'],
};
// Left tabs: plan + roster always. board iff boardSwarmRunID (i.e.
// blackboard or orchestrator-worker only). heat iff any file edits.

const ALL_VIEW_LABELS = ['timeline', 'chat', 'cards', 'board', 'contracts',
  'iterations', 'debate', 'map', 'council', 'strategy'];
const ALL_LEFT_TABS = ['plan', 'roster', 'board', 'heat'];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const observed = {}; // pattern -> { view: [...], left: [...] }

for (const [pattern, runID] of Object.entries(RUNS)) {
  console.log(`\n=== ${pattern}  (${runID}) ===`);
  await page.goto(`${BASE}/?swarmRun=${runID}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Wait until either the swarm-page chrome is up OR we hit a recognizable
  // error state.
  // Wait for the per-pattern toolbar to settle. The view-tab toolbar
  // is gated on `swarmRunMeta?.pattern`, which only resolves after
  // the snapshot fetch completes — that can take 4-6s on a cold dev
  // worker. Wait until either a pattern-specific tab appears OR a
  // generous fallback elapses.
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some(
      (b) => /^(timeline|plan|roster|run not found)$/i.test(b.textContent?.trim() ?? ''),
    ),
    null,
    { timeout: 25_000 },
  ).catch(() => {});
  await page.waitForTimeout(6000);

  // Pull every button-label that matches our expected vocabulary. The
  // toolbar uses lowercase labels; we lowercase before comparing.
  const found = await page.evaluate((vocab) => {
    const labels = new Set();
    Array.from(document.querySelectorAll('button')).forEach((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      if (vocab.includes(t)) labels.add(t);
    });
    return Array.from(labels);
  }, [...ALL_VIEW_LABELS, ...ALL_LEFT_TABS]);

  // The view-tab toolbar lives in the main viewport (not the left
  // section). Filter by which set each label belongs to.
  const view = found.filter((l) => ALL_VIEW_LABELS.includes(l));
  const left = found.filter((l) => ALL_LEFT_TABS.includes(l));
  observed[pattern] = { view, left };
  console.log(`  view tabs: ${view.sort().join(', ') || '(none)'}`);
  console.log(`  left tabs: ${left.sort().join(', ') || '(none)'}`);
}

await browser.close();

// Compare observed vs expected.
console.log('\n\n=== AUDIT — view tabs (main viewport) ===');
console.log('  pattern              | expected → observed              | result');
console.log('  ' + '─'.repeat(78));
let mismatches = 0;
for (const [pattern, expected] of Object.entries(EXPECTED_VIEW_TABS)) {
  const obs = observed[pattern].view.sort();
  const exp = [...expected].sort();
  const missing = exp.filter((t) => !obs.includes(t));
  const extra = obs.filter((t) => !exp.includes(t));
  const ok = missing.length === 0 && extra.length === 0;
  if (!ok) mismatches += 1;
  const detail = ok ? 'OK' : `missing:[${missing.join(',')}] extra:[${extra.join(',')}]`;
  console.log(`  ${pattern.padEnd(20)} | ${exp.join(',').padEnd(50)} | ${detail}`);
}

console.log('\n=== left tabs (per pattern, observed) ===');
console.log('  pattern              | left tabs');
console.log('  ' + '─'.repeat(60));
for (const pattern of Object.keys(RUNS)) {
  console.log(`  ${pattern.padEnd(20)} | ${observed[pattern].left.sort().join(', ') || '(none)'}`);
}

if (mismatches > 0) {
  console.log(`\n${mismatches} mismatch${mismatches === 1 ? '' : 'es'} — code review vs Playwright observed differ`);
  process.exit(1);
}
console.log('\nOK — all 7 patterns render the expected view-tab set');
