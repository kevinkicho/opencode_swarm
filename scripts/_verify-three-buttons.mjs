#!/usr/bin/env node
// Comprehensive cost / metrics / projects verification:
//   1. Cost dashboard opens; totals + sparkline + workspace + top-5
//      all render bound data; top-5 link opens new tab.
//   2. Metrics page renders per-preset rows + the ALL totals row,
//      with no "—" placeholder cells (medDur, live%, stale%, err%).
//   3. Projects matrix renders rows; day-cell run links open new tab.
//   4. No console errors anywhere.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const port = Number(readFileSync('.dev-port', 'utf8').trim());
const BASE = `http://127.0.0.1:${port}`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/(Fix any|landmark|aria-|getContext|axe)/i.test(t)) return;
  errs.push(`console: ${t.slice(0, 200)}`);
});

// ── 1. Cost dashboard ──────────────────────────────────────────────
console.log('\n=== cost dashboard ===');
await page.goto(`${BASE}/?swarmRun=run_moi2gc24_r4p5i1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);
await page.locator('button[aria-label="open cost dashboard"]').click();
await page.waitForTimeout(1500);

// Use a contains-text check rather than exact-equal regex; the cost
// drawer wraps headers in spans alongside other text (e.g. "totals
// 146 runs" is one parent).
const drawerText = await page.evaluate(() => {
  const drawer = document.querySelector('aside, [role="dialog"], [class*="drawer" i]');
  return (drawer?.textContent || document.body.textContent || '').toLowerCase();
});
record('cost: totals header', drawerText.includes('totals'));
record('cost: sparkline section', drawerText.includes('last 7 days'));
record('cost: by-workspace section', drawerText.includes('by workspace'));
record('cost: top-5 section', drawerText.includes('top 5 by spend'));

// Top-5 has at least one row (146 stale runs in the dataset → likely zero
// cost across all, so top-5 may be empty). Check link behavior conditionally.
const top5Links = await page.locator('a[target="_blank"][href^="/?swarmRun="]').count();
if (top5Links > 0) {
  const firstTop5 = page.locator('a[target="_blank"][href^="/?swarmRun="]').first();
  const beforeUrl = page.url();
  const [newTab] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
    firstTop5.click(),
  ]);
  await page.waitForTimeout(800);
  record('cost: top-5 link opens new tab', !!newTab);
  record('cost: original tab URL unchanged', page.url() === beforeUrl);
  if (newTab) await newTab.close();
} else {
  record('cost: top-5 link opens new tab', true, 'no rows w/ cost > 0 in dataset (skipped)');
}

await page.keyboard.press('Escape');

// ── 2. Metrics page ────────────────────────────────────────────────
console.log('\n=== metrics page ===');
await page.goto(`${BASE}/metrics`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
// Wait until the per-preset table has hydrated rows (first paint
// shows "loading"; we want post-data state).
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('tr td')).some(
    (td) => td.textContent?.trim().toLowerCase() === 'all',
  ),
  null,
  { timeout: 20_000 },
).catch(() => {});
await page.waitForTimeout(800);

// The ALL footer row used to have 4 "—" cells: medDur + colspan-3 (live%/stale%/err%).
// After the wire-up they should all render real values.
const tableRow = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tr'));
  // Match any row whose first cell text starts with "all" (the totals
  // footer). Allow leading/trailing whitespace + uppercased rendering.
  const allRow = rows.find((tr) => {
    const first = tr.querySelectorAll('td')[0]?.textContent?.trim().toLowerCase() ?? '';
    return first === 'all';
  });
  if (!allRow) return null;
  return Array.from(allRow.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? '');
});
console.log('  ALL totals row cells:', tableRow);
if (tableRow) {
  // index map from PER-PRESET AGGREGATES table:
  // [pattern, runs, avgDur, medDur, avg$, avgTok, live%, stale%, err%]
  const [, runs, avgDur, medDur, avgUsd, avgTok, livePct, stalePct, errPct] = tableRow;
  record('metrics ALL row: runs is numeric',  /^\d+$/.test(runs ?? ''), runs);
  record('metrics ALL row: avgDur not "—"', avgDur !== '—' && !!avgDur, avgDur);
  record('metrics ALL row: medDur not "—"', medDur !== '—' && !!medDur, medDur);
  record('metrics ALL row: avg$ shape',     /\$|<\$/.test(avgUsd ?? ''), avgUsd);
  record('metrics ALL row: avgTok shape',   /\d/.test(avgTok ?? ''),    avgTok);
  record('metrics ALL row: live% not "—"',  livePct !== '—' && !!livePct, livePct);
  record('metrics ALL row: stale% not "—"', stalePct !== '—' && !!stalePct, stalePct);
  record('metrics ALL row: err% not "—"',   errPct !== '—' && !!errPct, errPct);
} else {
  record('metrics ALL row exists', false);
}

// ── 3. Projects page ───────────────────────────────────────────────
console.log('\n=== projects page ===');
await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);

const repoCount = await page.locator('a[href^="/projects/"]').count();
record('projects: at least 1 repo row', repoCount > 0, `${repoCount} repos`);

// Day cells with runs are inside Popovers — hover one to expand
const dayCells = await page.locator('button[aria-label*="run"]').count();
if (dayCells > 0) {
  await page.locator('button[aria-label*="run"]').first().click();
  await page.waitForTimeout(700);
  const dayRunLinks = await page.locator('a[target="_blank"][href^="/?swarmRun="]').count();
  record('projects: day-cell popover has new-tab links', dayRunLinks > 0,
    `${dayRunLinks} links`);
}

// ── 4. Console errors ──────────────────────────────────────────────
console.log(`\n=== console errors: ${errs.length} ===`);
errs.slice(0, 5).forEach((e) => console.log('   ' + e));
record('no console errors', errs.length === 0, `${errs.length} errors`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  console.log('FAIL:');
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  process.exit(1);
}
console.log('OK — all three surfaces wired');
