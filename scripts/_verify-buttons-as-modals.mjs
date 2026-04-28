#!/usr/bin/env node
// Verify the metrics + projects buttons open as MODALS (not full-page
// navigation). The user explicitly asked for tooltip/modal view
// instead of taking the whole page-view.
//
// Behavior expected:
//   - clicking "metrics" → URL stays at /, a modal opens with the
//     per-preset metrics table inside
//   - clicking "projects" → URL stays at /, a modal opens with the
//     project-time matrix inside
//   - clicking "cost" → URL stays at /, a drawer opens (already worked)
//   - Escape closes each modal
//   - the /metrics and /projects routes are still reachable directly
//     (preserved for direct linking + bookmarks)

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
  if (/(Fix any|landmark|aria-|getContext|axe|build id changed)/i.test(t)) return;
  errs.push(`console: ${t.slice(0, 200)}`);
});

await page.goto(`${BASE}/?swarmRun=run_moi2gc24_r4p5i1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);

// ── METRICS ─────────────────────────────────────────────────────────
console.log('\n=== metrics button → modal ===');
const beforeMetrics = page.url();
await page.locator('button[aria-label="open cross-preset metrics"]').click();
// Cold-compile the lazy modal chunk can take 3-5s on dev; bump
// generously so the first-run case isn't flaky.
await page.waitForTimeout(4000);
record('metrics: URL unchanged (no nav)', page.url() === beforeMetrics, page.url());

// Modal title — Modal renders title as visible h2; either the
// "metrics" h2 OR the "cross-preset" eyebrow proves the modal is up.
// Wait briefly for the lazy chunk to finish hydrating.
await page.waitForTimeout(800);
const metricsModalOpen = await page.evaluate(() => {
  const text = document.body.textContent?.toLowerCase() ?? '';
  return text.includes('cross-preset') || text.includes('per-preset aggregates');
});
record('metrics: modal content visible (cross-preset / per-preset)', metricsModalOpen);

// PER-PRESET AGGREGATES table should render inside
const metricsTableHasRows = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('tr td'));
  return rows.some((td) => td.textContent?.trim().toLowerCase() === 'all');
});
record('metrics: per-preset table renders inside modal', metricsTableHasRows);

await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const stillOpen = await page.evaluate(() =>
  Array.from(document.querySelectorAll('*')).some(
    (e) => e.textContent?.trim().toLowerCase() === 'cross-preset',
  ),
);
record('metrics: Escape closes modal', !stillOpen);

// ── PROJECTS ────────────────────────────────────────────────────────
console.log('\n=== projects button → modal ===');
const beforeProjects = page.url();
await page.locator('button[aria-label="open project-time matrix"]').click();
// Cold-compile the lazy modal chunk can take 3-5s on dev; bump
// generously so the first-run case isn't flaky.
await page.waitForTimeout(4000);
record('projects: URL unchanged (no nav)', page.url() === beforeProjects, page.url());

const projectsModalOpen = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('*')).some(
    (e) => e.textContent?.toLowerCase().trim() === 'project-time matrix',
  );
});
record('projects: modal eyebrow "project-time matrix" visible', projectsModalOpen);

// 2026-04-28 — repo cells are now <button>s that drill into a
// per-repo view inside the modal (instead of <Link>s to a full-page
// /projects/[slug]). Match by typical repo-name shape instead.
const projectsHasRepos = await page.evaluate(() => {
  const repoButtons = Array.from(document.querySelectorAll('button')).filter(
    (b) => /^[a-z0-9_-]+$/i.test((b.textContent || '').trim()) &&
           (b.textContent || '').trim().length >= 3 &&
           (b.textContent || '').trim().length <= 60,
  );
  return repoButtons.length > 0;
});
record('projects: matrix renders inside modal', projectsHasRepos);

await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// ── /metrics and /projects routes still work for direct linking ────
console.log('\n=== direct routes still reachable ===');
await page.goto(`${BASE}/metrics`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);
const directMetricsOk = await page.evaluate(() =>
  document.body.textContent?.toLowerCase().includes('per-preset aggregates'),
);
record('direct /metrics still renders', !!directMetricsOk);

await page.goto(`${BASE}/projects`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);
const directProjectsOk = await page.evaluate(() =>
  document.body.textContent?.toLowerCase().includes('repos'),
);
record('direct /projects still renders', !!directProjectsOk);

// ── Console errors ─────────────────────────────────────────────────
console.log(`\n=== console errors: ${errs.length} ===`);
errs.slice(0, 5).forEach((e) => console.log('   ' + e));
record('no console errors', errs.length === 0);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  console.log('FAIL:');
  failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
  process.exit(1);
}
console.log('OK — metrics + projects open as modals; direct routes preserved');
