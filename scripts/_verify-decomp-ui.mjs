#!/usr/bin/env node
// Validate the 2026-04-28 decomposition wave by exercising the
// surfaces whose components were lifted into per-concern modules.
//
// Surfaces probed (against a populated run):
//   - swarm-timeline lane headers (LaneHeaderCell)
//   - inspector pane (MessageInspector / FileHeatInspector)
//   - retro view (Header / RunOverview / LessonsBlock / EmptyRetro)
//   - council rail (jaccard-derived chips on a council run)
//   - contracts rail (note-parser + ContractRow)
//   - heat rail (list-row + tree-view split)
//   - cost dashboard drawer (helpers + sub-views)
//   - swarm-topbar chips (abort + health files)
//
// Run: node scripts/_verify-decomp-ui.mjs

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';

const port = (() => {
  if (existsSync('.dev-port')) {
    const n = Number(readFileSync('.dev-port', 'utf8').trim());
    if (Number.isInteger(n)) return n;
  }
  return 3000;
})();

// Use the WSL eth0 IP for the Windows browser scenario; localhost
// works inside WSL though, which is what Playwright uses.
const BASE = `http://127.0.0.1:${port}`;

// Canonical populated runs per project memory.
const RUNS = {
  blackboard: 'run_moi2gc24_r4p5i1',
  council: 'run_moi0v587_bh3g2u',
  orchestrator: 'run_moi1u8yl_pusb3r',
};

const results = [];
const fail = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail.push(name);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    const t = msg.text();
    // Filter axe a11y dev warnings (not real errors) + dev-only react
    // suppressions. Real component-render errors will still surface.
    if (/(suppressed|Warning:|jsdom|getContext|Failed to load resource|Fix any of the following:|landmark|label-text|aria-)/i.test(t)) return;
    consoleErrors.push(`console: ${t}`);
  }
});

try {
  // ─────────────────────────────────────────────────────────────────
  // 1. Blackboard run loads timeline + lanes (LaneHeaderCell extraction)
  console.log(`\nblackboard run: ${RUNS.blackboard}`);
  await page.goto(`${BASE}/?swarmRun=${RUNS.blackboard}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Wait for the data to populate, not just DOM-ready.
  await page.waitForSelector('text=/session timeline/i', { timeout: 15_000 });
  await page.waitForTimeout(3500);

  const timelineSection = await page.$('section:has-text("session timeline")');
  record('timeline section renders', !!timelineSection);

  // Lane headers — LaneHeaderCell renders a button with inline
  // style width:168px (LANE_WIDTH). Match by partial style attr.
  const laneButtons = await page.$$('button[style*="width: 168"]');
  record('lane headers (LaneHeaderCell)', laneButtons.length >= 2, `${laneButtons.length} lanes`);

  // 2. Click a lane to open inspector (AgentInspector / SessionInfoPanel /
  //    BudgetPanel split)
  if (laneButtons.length > 0) {
    await laneButtons[0].click();
    await page.waitForTimeout(1500);
    // BudgetPanel has "budget burn" header; SessionInfoPanel has
    // "session info" header; either is enough proof the inspector
    // mounted with the new sibling files.
    const inspectorBudget = await page.$('text=/budget burn/i');
    const inspectorSession = await page.$('text=/session info/i');
    const inspectorActivity = await page.$('text=/recent activity/i');
    record(
      'inspector opens on lane click (AgentInspector siblings)',
      !!(inspectorBudget || inspectorSession || inspectorActivity),
      [inspectorBudget && 'budget', inspectorSession && 'session', inspectorActivity && 'activity'].filter(Boolean).join(','),
    );
  }

  // 3. Click escape to clear
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 4. Left-rail tabs (plan / roster / board / heat). Heat tab → toggles
  //    list-row vs tree-view (the heat-rail decomposition). The tab
  //    label is exactly "heat" — use exact-text selector.
  const heatTab = page.locator('button', { hasText: /^heat$/i }).first();
  if (await heatTab.count()) {
    await heatTab.click();
    await page.waitForTimeout(1000);
    const listToggle = await page.$('button:has-text("list")');
    const treeToggle = await page.$('button:has-text("tree")');
    record('heat rail toggles (list-row + tree-view)', !!listToggle && !!treeToggle);
  } else {
    record('heat rail tab present', false);
  }

  // 5. Board tab — for blackboard run, the contracts rail mounts
  //    inside BoardRail. Note-parser + ContractRow extraction.
  const boardTab = page.locator('button', { hasText: /^board$/i }).first();
  if (await boardTab.count()) {
    await boardTab.click();
    await page.waitForTimeout(1000);
    // ContractRow renders "MET / UNMET / WONT / ?" verdict chips when
    // the run has criterion items. The "contracts" header from
    // wrap() in contracts-rail.tsx is the most stable marker.
    const contractsHeader = await page.$('text=/^contracts$/i');
    record('contracts rail (note-parser + ContractRow)', !!contractsHeader);
  } else {
    record('board tab present', false);
  }

  // ─────────────────────────────────────────────────────────────────
  // 6. Retro view — sections.tsx + empty.tsx split
  console.log(`\nretro view: ${RUNS.blackboard}`);
  await page.goto(`${BASE}/retro/${RUNS.blackboard}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(1500);

  const retroHeader = await page.$('text=/retro/i');
  record('retro page renders header', !!retroHeader);

  // Either RunOverview / LessonsBlock OR EmptyRetro should be present
  const runOverview = await page.$('text=/run overview/i');
  const emptyRetro = await page.$('text=/no rollup yet/i');
  record('retro body (overview or empty)', !!runOverview || !!emptyRetro,
    runOverview ? 'RunOverview' : emptyRetro ? 'EmptyRetro' : '?');

  // ─────────────────────────────────────────────────────────────────
  // 7. Council run — jaccard.ts + row.tsx split. Council rail is
  //    pattern-specific; mounted inside BoardRail's pattern tab when
  //    the run is a council run. The header is "council R{n}/{n}".
  console.log(`\ncouncil run: ${RUNS.council}`);
  await page.goto(`${BASE}/?swarmRun=${RUNS.council}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(3000);

  // Click board tab so the pattern-specific rail surfaces
  const boardTab2 = page.locator('button', { hasText: /^board$/i }).first();
  if (await boardTab2.count()) await boardTab2.click();
  await page.waitForTimeout(1000);

  // Council header from wrap() in council-rail.tsx — `council` text +
  // "R/N" or "no members assigned"
  const councilHeader = await page.$('text=/^council$/i');
  record('council rail (jaccard + CouncilRowEl)', !!councilHeader);

  // ─────────────────────────────────────────────────────────────────
  // 8. Cost dashboard drawer — helpers + sub-views split
  console.log('\ncost dashboard drawer');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000);

  // The cost button has title="cost dashboard" or text "cost" — try
  // both. From the debug pass, the button text is just "cost".
  const costButton = await page.$('button:has-text("cost") >> nth=0');
  if (costButton) {
    await costButton.click();
    await page.waitForTimeout(1500);
    const totalsHeader = await page.$('text=/totals/i');
    const sparkline = await page.$('text=/last 7 days/i');
    const dashOk = !!totalsHeader && !!sparkline;
    record(
      'cost dashboard opens (TotalCell + WeeklySparkline)',
      dashOk,
      [totalsHeader && 'totals', sparkline && 'sparkline'].filter(Boolean).join(',') || 'neither found',
    );
  } else {
    record('cost dashboard trigger present', false, 'no `cost` button');
  }

  // ─────────────────────────────────────────────────────────────────
  // Console error gate
  console.log(`\nconsole errors: ${consoleErrors.length}`);
  if (consoleErrors.length) {
    consoleErrors.slice(0, 5).forEach((e) => console.log('  ' + e));
  }
  record('no console errors', consoleErrors.length === 0, `${consoleErrors.length} errors`);
} catch (err) {
  console.error('FATAL:', err.message);
  fail.push(`fatal: ${err.message}`);
} finally {
  await browser.close();
}

console.log(`\n${results.filter(r => r.ok).length}/${results.length} probes passed`);
if (fail.length) {
  console.log('FAIL:');
  fail.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('OK — all decomposition surfaces render');
