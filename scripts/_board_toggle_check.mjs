#!/usr/bin/env node
// Verify board tab content renders after toggling other tabs — the SSE
// subscription should persist, so the second visit to board should have
// items ready without re-handshaking.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('button:has-text("heat")', { timeout: 20_000 });

// First visit to board tab — may have first-compile latency
console.time('first board visit');
await page.locator('button:has-text("board")').first().click();
await page.waitForSelector('[aria-label], .hairline-b', { timeout: 15_000 });
const itemsAfterFirstClick = await page
  .locator('ul.list-none > li')
  .count()
  .catch(() => 0);
console.timeEnd('first board visit');
console.log('  items visible:', itemsAfterFirstClick);

// Leave to heat, then back to board
await page.locator('button:has-text("heat")').first().click();
await page.waitForTimeout(400);
console.time('second board visit');
await page.locator('button:has-text("board")').first().click();
// With hooks lifted, the snapshot should already be in state — no
// re-handshake wait. Give a tiny buffer for React to render.
await page.waitForTimeout(200);
const itemsAfterSecondClick = await page
  .locator('ul.list-none > li')
  .count()
  .catch(() => 0);
console.timeEnd('second board visit');
console.log('  items visible:', itemsAfterSecondClick);

await page.screenshot({ path: '/tmp/board-toggle.png', fullPage: false });
await browser.close();
