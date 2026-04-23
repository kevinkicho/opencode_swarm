#!/usr/bin/env node
// Load the run view, switch to cards, dump structure + take a screenshot.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
// Wait for data to actually load — heat tab appearance is our proxy
// for "live data is in." If heat never appears within the window the
// run probably hasn't replayed; fall back to the fixed wait.
try {
  await page.waitForSelector('button:has-text("heat")', { timeout: 10_000 });
} catch {
  console.log('[warn] heat tab never appeared — data may be stale');
}
await page.waitForTimeout(1500);

// Click "cards" toggle (view: timeline | cards)
await page.locator('button:has-text("cards")').first().click();
// Wait for cards to actually render — agent columns appear once data
// flows into the view.
try {
  await page.waitForFunction(
    () => document.querySelectorAll('section.flex-1 ul > li').length > 0,
    null,
    { timeout: 15_000 },
  );
} catch {
  console.log('[warn] cards never rendered');
}
await page.waitForTimeout(500);

// Column headers (agent name + turn count)
const columns = await page
  .locator('section.flex-1 > div > div')
  .evaluateAll((els) =>
    els.map((el, i) => ({
      idx: i,
      width: Math.round(el.getBoundingClientRect().width),
      text: (el.innerText || '').slice(0, 120).replace(/\n+/g, ' | '),
    })).slice(0, 6),
  );
console.log('cards view columns:');
for (const c of columns) console.log(' ', c);

// Cards inside each column
const cards = await page
  .locator('section.flex-1 ul > li')
  .evaluateAll((els) =>
    els.map((el, i) => {
      const box = el.getBoundingClientRect();
      return {
        idx: i,
        height: Math.round(box.height),
        width: Math.round(box.width),
        text: (el.innerText || '').replace(/\n+/g, ' ¶ ').slice(0, 180),
      };
    }).slice(0, 6),
  );
console.log('\nfirst 6 cards:');
for (const c of cards) console.log(' ', c);

// How many columns total, how many cards per column
const colCount = await page.locator('section.flex-1 > div > div').count();
const cardCount = await page.locator('section.flex-1 ul > li').count();
console.log(`\ntotals: ${colCount} columns / ${cardCount} cards`);

await page.screenshot({ path: '/tmp/cards-view.png', fullPage: false });
console.log('screenshot: /tmp/cards-view.png');
await browser.close();
