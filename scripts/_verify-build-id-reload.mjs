#!/usr/bin/env node
// Verify the build-id auto-reload safety net:
//   1. Load page → captures current build id
//   2. Route the next /api/dev/build-id to a stubbed response with a
//      different id
//   3. Trigger visibilitychange (simulate tab regaining focus)
//   4. Page should reload (location.reload)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const port = Number(readFileSync('.dev-port', 'utf8').trim());
const URL = `http://127.0.0.1:${port}/?swarmRun=run_moi2gc24_r4p5i1`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const log = (...args) => console.log(...args);
const reloadEvents = [];
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) reloadEvents.push({ url: frame.url(), at: Date.now() });
});
page.on('console', (msg) => {
  const t = msg.text();
  if (/build id changed|reloading stale tab/i.test(t)) {
    log(`  [console.${msg.type()}]`, t);
  }
});

log('1. load page (captures real build-id)');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForTimeout(2500);
log(`  initial nav events: ${reloadEvents.length}`);

log('\n2. install route stub returning a different build-id');
let serveStub = false;
await page.route('**/api/dev/build-id', async (route) => {
  if (serveStub) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'dev-stubbed-different-id' }),
    });
  } else {
    await route.continue();
  }
});

log('\n3. flip the stub on, fire visibilitychange');
serveStub = true;
const navsBefore = reloadEvents.length;
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
});
// Allow up to ~3s for the fetch + reload
await page.waitForTimeout(3500);

log(`\n4. nav events after visibilitychange: ${reloadEvents.length} (was ${navsBefore})`);
const reloaded = reloadEvents.length > navsBefore;
log(`  page reloaded: ${reloaded}`);
log(`  final url: ${page.url()}`);

await browser.close();
if (!reloaded) {
  console.error('\nFAIL — page did not auto-reload on build-id mismatch');
  process.exit(1);
}
console.log('\nOK — build-id staleness detector triggered reload');
