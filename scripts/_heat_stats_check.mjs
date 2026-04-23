#!/usr/bin/env node
// Inspect heat rows — do they show +N / -N numbers, or just —?
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('button:has-text("heat")', { timeout: 20_000 });
await page.locator('button:has-text("heat")').first().click();
// Wait for diff to load — up to 10s since useSessionDiff fires async.
await page.waitForTimeout(8_000);

const rows = await page
  .locator('ul.list-none > li')
  .evaluateAll((els) =>
    els.slice(0, 8).map((el) => el.innerText.replace(/\n/g, ' | ').trim()),
  );
console.log('first 8 heat rows:');
for (const r of rows) console.log(' ', r);

await page.screenshot({ path: '/tmp/heat-stats.png', fullPage: false });
await browser.close();
