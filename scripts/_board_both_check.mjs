#!/usr/bin/env node
// Verify (1) main-view `board` toggle is kanban and (2) left-rail
// `board` tab is the 6-section accordion with all statuses visible.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('button:has-text("heat")', { timeout: 20_000 });
await page.waitForTimeout(1000);

// --- LEFT-RAIL BOARD TAB (accordion expected) ---
await page.locator('section.sidebar-seam button:has-text("board")').first().click();
await page.waitForTimeout(800);

const railSections = await page
  .locator('section.sidebar-seam button:has-text("in-progress"), section.sidebar-seam button:has-text("claimed"), section.sidebar-seam button:has-text("open"), section.sidebar-seam button:has-text("stale"), section.sidebar-seam button:has-text("blocked"), section.sidebar-seam button:has-text("done")')
  .evaluateAll((els) => els.map((el) => el.innerText.replace(/\n/g, ' ').trim()));
console.log('left-rail accordion sections:');
for (const s of railSections) console.log(' ', s);

await page.screenshot({ path: '/tmp/board-rail.png', fullPage: false });

// --- MAIN-VIEW BOARD TOGGLE (kanban expected) ---
await page.locator('div.h-7 button:has-text("board")').first().click();
await page.waitForTimeout(1000);

// Kanban has 6 column headers in a grid
const mainColumns = await page
  .locator('section.flex-1 > div:first-of-type > div')
  .evaluateAll((els) =>
    els
      .slice(0, 6)
      .map((el) => ({
        width: Math.round(el.getBoundingClientRect().width),
        text: el.innerText.replace(/\n/g, ' ').trim(),
      })),
  );
console.log('\nmain-view kanban columns:');
for (const c of mainColumns) console.log(' ', c);

await page.screenshot({ path: '/tmp/board-main.png', fullPage: false });
console.log('\nscreenshots: /tmp/board-rail.png, /tmp/board-main.png');
await browser.close();
