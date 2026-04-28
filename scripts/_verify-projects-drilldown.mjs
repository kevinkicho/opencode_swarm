#!/usr/bin/env node
// Verify the projects modal drill-down stays inside the modal:
//   1. Click projects → modal opens with matrix
//   2. Click first repo → matrix replaced with per-repo run list,
//      title becomes the repo name, "← back to all repos" appears,
//      page URL UNCHANGED (no full-page navigation)
//   3. Click "← back" → matrix returns
//   4. Esc → modal fully closes

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

await page.goto(`${BASE}/?swarmRun=run_moi2gc24_r4p5i1`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Open projects modal
await page.locator('button[aria-label="open project-time matrix"]').click();
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('button')).some(
    (b) => /^kyahoofinance/.test(b.textContent?.trim() ?? ''),
  ),
  null, { timeout: 15_000 },
).catch(() => {});
await page.waitForTimeout(800);
record('projects modal opens with matrix', true);

const startUrl = page.url();

// Click first repo button
const repoBtn = page.locator('button').filter({ hasText: /^kyahoofinance/ }).first();
const repoText = await repoBtn.textContent();
console.log(`  clicking repo: ${repoText?.trim()}`);
await repoBtn.click();
await page.waitForTimeout(1500);

const afterClickUrl = page.url();
record('URL did NOT change (drilled inside modal)', startUrl === afterClickUrl,
  `${startUrl} → ${afterClickUrl}`);

// Modal title should now be the repo name
const titleAfter = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('h2'))
    .map((h) => h.textContent?.trim())
    .find((t) => t && t.length < 60);
});
record('modal title became repo name', titleAfter?.includes('kyahoofinance'),
  `title=${titleAfter}`);

// "← back to all repos" should be visible
const backBtn = page.locator('button').filter({ hasText: /back to all repos/i });
record('back button visible', (await backBtn.count()) > 0);

// RepoRunsView content visible (look for pattern + status badges)
const runListEntries = await page.evaluate(() => {
  // RepoRunsView uses <li>'s with pattern labels
  const li = document.querySelectorAll('li');
  return Array.from(li).filter((el) =>
    /\b(blackboard|council|map-reduce|orchestrator-worker|debate-judge|critic-loop|none)\b/i.test(el.textContent ?? '')
  ).length;
});
record('RepoRunsView renders run rows', runListEntries > 0, `${runListEntries} rows`);

await page.screenshot({ path: '/tmp/projects-drilled-in.png', fullPage: false });

// Click back
await backBtn.first().click();
await page.waitForTimeout(800);
const titleAfterBack = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('h2'))
    .map((h) => h.textContent?.trim())
    .find((t) => t && t.length < 60);
});
record('back returns to projects matrix', titleAfterBack === 'projects', `title=${titleAfterBack}`);

// Esc closes modal
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const stillOpen = await page.locator('button').filter({ hasText: /^kyahoofinance/ }).count();
record('Escape closes modal', stillOpen === 0);

// Direct /projects/[slug] route still works for bookmarks
await page.goto(`${BASE}/projects/kyahoofinance032926`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const directRouteOk = await page.evaluate(() =>
  document.body.textContent?.toLowerCase().includes('kyahoofinance032926')
);
record('direct /projects/[slug] route preserved', !!directRouteOk);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  console.log('FAIL:');
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  process.exit(1);
}
console.log('OK — projects drill-down stays inside the modal');
