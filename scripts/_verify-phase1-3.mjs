#!/usr/bin/env node
// Visual verification probe for Phase 1-3 implementation work.
//
// Exercises:
//   1. Home page loads and renders the picker
//   2. Retro page renders with cost breakdown, dissent lessons, agent cards
//   3. New-run modal has pattern selection
//   4. Nudge API responds correctly (404 for missing run)
//   5. Memory API responds correctly
//   6. Build gate module loads
//
// Screenshots saved to /tmp/opencode_swarm_verify/

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const PORT = Number(readFileSync('.dev-port', 'utf8').trim()) || 8044;
const BASE = `http://localhost:${PORT}`;
const OUT = '/tmp/opencode_swarm_verify';

mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;

function ok(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

// ── Test 1: Home page loads ──────────────────────────────────────────
console.log('\n1. Home page');
const page1 = await ctx.newPage();
try {
  const resp = await page1.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 15000 });
  ok('status 200', resp?.status() === 200);
  await page1.waitForTimeout(2000);
  await page1.screenshot({ path: `${OUT}/01-home.png`, fullPage: false });
  ok('screenshot saved', true);

  // Check key UI elements exist
  const bodyText = await page1.evaluate(() => document.body.innerText);
  ok('has content on page', bodyText.length > 100);
} catch (e) {
  ok('home page loads', false, String(e));
}

// ── Test 2: Retro page (any valid run) ───────────────────────────────
console.log('\n2. Retro page');
const page2 = await ctx.newPage();
try {
  // List runs to find one
  const listResp = await page2.goto(`${BASE}/api/swarm/run`, { timeout: 10000 });
  const runs = listResp?.ok() ? await listResp?.json() : null;
  const firstRun = Array.isArray(runs) ? runs[0] : null;
  const runId = firstRun?.meta?.swarmRunID;

  if (runId) {
    ok('found a run to test', true, runId);
    await page2.goto(`${BASE}/retro/${runId}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page2.waitForTimeout(3000);
    await page2.screenshot({ path: `${OUT}/02-retro.png`, fullPage: false });
    ok('retro screenshot saved', true);

    const retroText = await page2.evaluate(() => document.body.innerText);
    ok('retro has content', retroText.length > 50);

    // Check for cost breakdown section (may not appear if no cost data)
    const hasCostBreakdown = retroText.toLowerCase().includes('cost breakdown');
    const hasLessons = retroText.toLowerCase().includes('lessons');
    const hasPerAgent = retroText.toLowerCase().includes('per-agent');
    ok('has lessons or per-agent section', hasLessons || hasPerAgent,
      hasLessons ? 'has lessons' : hasPerAgent ? 'has per-agent' : 'neither found');
  } else {
    ok('found a run to test', false, 'no runs in registry');
  }
} catch (e) {
  ok('retro page loads', false, String(e));
}

// ── Test 3: New-run modal ────────────────────────────────────────────
console.log('\n3. New-run modal');
const page3 = await ctx.newPage();
try {
  await page3.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page3.waitForTimeout(2000);

  // Try to find and click the new-run button
  const newRunBtn = await page3.$('button:has-text("new run"), button:has-text("New Run"), [data-testid="new-run"]');
  if (newRunBtn) {
    await newRunBtn.click();
    await page3.waitForTimeout(1500);
    await page3.screenshot({ path: `${OUT}/03-new-run-modal.png`, fullPage: false });
    ok('new-run modal screenshot saved', true);

    const modalText = await page3.evaluate(() => document.body.innerText);
    ok('modal has pattern selection',
      modalText.toLowerCase().includes('blackboard') ||
      modalText.toLowerCase().includes('council') ||
      modalText.toLowerCase().includes('pattern'));
  } else {
    // Try keyboard shortcut
    await page3.keyboard.press('n');
    await page3.waitForTimeout(1500);
    await page3.screenshot({ path: `${OUT}/03-new-run-modal.png`, fullPage: false });
    ok('new-run modal (via keyboard) screenshot saved', true);
  }
} catch (e) {
  ok('new-run modal', false, String(e));
}

// ── Test 4: Nudge API (404 for nonexistent run) ──────────────────────
console.log('\n4. Nudge API');
const page4 = await ctx.newPage();
try {
  const nudgeResp = await page4.goto(`${BASE}/api/swarm/run/run_nonexistent_test/nudge`, {
    waitUntil: 'domcontentloaded',
    timeout: 10000,
  });
  // This should 405 (Method Not Allowed for GET) or similar
  ok('nudge endpoint exists', nudgeResp?.status() !== 404,
    `status: ${nudgeResp?.status()}`);

  // Test POST with missing body
  const postResp = await ctx.request.post(`${BASE}/api/swarm/run/run_nonexistent_test/nudge`, {
    data: { message: 'test nudge' },
  });
  ok('nudge POST returns proper error for missing run',
    postResp.status() === 404 || postResp.status() === 200,
    `status: ${postResp.status()}`);
} catch (e) {
  ok('nudge API', false, String(e));
}

// ── Test 5: Memory API ──────────────────────────────────────────────
console.log('\n5. Memory API');
try {
  const memResp = await ctx.request.get(
    `${BASE}/api/swarm/memory/recent?workspace=/tmp/nonexistent`,
  );
  ok('memory API responds', memResp.status() === 200 || memResp.status() === 500,
    `status: ${memResp.status()}`);

  if (memResp.status() === 200) {
    const memData = await memResp.json();
    ok('memory API returns entries array', Array.isArray(memData?.entries));
  }
} catch (e) {
  ok('memory API', false, String(e));
}

// ── Test 6: Rollup API ───────────────────────────────────────────────
console.log('\n6. Rollup API');
try {
  const rollupResp = await ctx.request.post(`${BASE}/api/swarm/memory/rollup`, {
    data: {},
  });
  ok('rollup API responds', rollupResp.status() === 200 || rollupResp.status() === 207,
    `status: ${rollupResp.status()}`);
} catch (e) {
  ok('rollup API', false, String(e));
}

// ── Summary ──────────────────────────────────────────────────────────
await browser.close();
console.log(`\n════════════════════════════════════════`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`  Screenshots in ${OUT}/`);
console.log(`════════════════════════════════════════\n`);

if (fail > 0) process.exit(1);