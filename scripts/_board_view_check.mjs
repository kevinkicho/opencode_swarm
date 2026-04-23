#!/usr/bin/env node
// Verify the new main-view "board" toggle renders the kanban.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('button:has-text("heat")', { timeout: 20_000 });

// The board toggle should only show for blackboard runs.
const boardToggleExists = await page.locator('button:has-text("board")').count();
console.log('board toggle count (expect >=2: left-rail tab + main view):', boardToggleExists);

// Click the main-view `board` toggle (the second "board" button, since
// the first one is the left-rail tab). Use the view-toggle container
// selector to be specific.
await page
  .locator('div.h-7 button', { hasText: 'board' })
  .first()
  .click();
await page.waitForTimeout(1500);

// Kanban should have 6 columns (in-progress / claimed / open / stale / blocked / done)
const columnHeaders = await page
  .locator('section.flex-1 > div:first-child > div')
  .evaluateAll((els) => els.map((el) => el.textContent?.trim() || '').slice(0, 6));
console.log('column headers:', columnHeaders);

// Count items per column
const items = await page
  .locator('section.flex-1 > div:nth-child(2) > div')
  .evaluateAll((cols) =>
    cols.map((col, i) => ({
      column: i,
      items: col.querySelectorAll(':scope > div').length,
    })),
  );
console.log('items per column:', items);

await page.screenshot({ path: '/tmp/board-view.png', fullPage: false });
console.log('screenshot: /tmp/board-view.png');
await browser.close();
