#!/usr/bin/env node
// Verify the picker row + retro chip both open in a new tab and
// the original tab is unaffected. The desired behavior:
//
//   - left-click on row → new tab with /?swarmRun=<id>
//   - left-click on retro chip → new tab with /retro/<id>
//   - original tab URL unchanged, picker still open
//
// Locks the new-tab semantics in so a future refactor can't silently
// regress to same-tab navigation.

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

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);

// ── Row click → new tab ─────────────────────────────────────────────
await page.locator('button[aria-label="browse swarm runs"]').click();
await page.waitForTimeout(700);

const row = page.locator('a[href^="/?swarmRun="]').first();
const rowHref = await row.getAttribute('href');
const rowTarget = await row.getAttribute('target');
record('row link has target=_blank', rowTarget === '_blank', `target=${rowTarget}`);

const beforePages = ctx.pages().length;
const beforeUrl = page.url();
const [newRowPage] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
  row.click(),
]);
await page.waitForTimeout(800);

record('row click opens new tab', !!newRowPage);
record('original tab URL unchanged', page.url() === beforeUrl, `before=${beforeUrl} after=${page.url()}`);
record('picker still open after row click',
  (await page.locator('text=/^swarm runs$/i').count()) > 0);
if (newRowPage) {
  record('new tab url matches row href', newRowPage.url().endsWith(rowHref || ''),
    newRowPage.url());
  await newRowPage.close();
}

// ── Retro chip click → new tab ──────────────────────────────────────
// Picker should still be open; if not, re-open
const headerStillThere = (await page.locator('text=/^swarm runs$/i').count()) > 0;
if (!headerStillThere) {
  await page.locator('button[aria-label="browse swarm runs"]').click();
  await page.waitForTimeout(500);
}

// Hover a retro-eligible row to reveal the chip
await page.locator('a[href^="/?swarmRun="]').first().hover();
await page.waitForTimeout(300);

const retroLink = page.locator('a[href^="/retro/"]').first();
const retroCount = await retroLink.count();
if (retroCount === 0) {
  record('retro link surfaces on hover', false, 'first row may be ineligible');
} else {
  const retroHref = await retroLink.getAttribute('href');
  const retroTarget = await retroLink.getAttribute('target');
  record('retro link has target=_blank', retroTarget === '_blank', `target=${retroTarget}`);

  const beforeUrl2 = page.url();
  const [newRetroPage] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
    retroLink.click(),
  ]);
  await page.waitForTimeout(800);
  record('retro click opens new tab', !!newRetroPage);
  record('original tab URL unchanged after retro', page.url() === beforeUrl2);
  if (newRetroPage) {
    record('new retro tab url matches', newRetroPage.url().endsWith(retroHref || ''),
      newRetroPage.url());
    await newRetroPage.close();
  }
}

// ── Picker dismiss (escape key) ─────────────────────────────────────
if ((await page.locator('text=/^swarm runs$/i').count()) === 0) {
  await page.locator('button[aria-label="browse swarm runs"]').click();
  await page.waitForTimeout(400);
}
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
record('Escape closes picker',
  (await page.locator('text=/^swarm runs$/i').count()) === 0);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) {
  console.log('FAIL:');
  failed.forEach((f) => console.log('  - ' + f.name));
  process.exit(1);
}
console.log('OK — picker opens runs + retro in new tabs, original tab undisturbed');
