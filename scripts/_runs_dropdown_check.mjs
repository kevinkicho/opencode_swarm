#!/usr/bin/env node
// Open the topbar runs dropdown, dump its rows + box sizes.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForTimeout(4000); // let /api/swarm/run populate

// Click the topbar `runs ▾` button (first one — the second is in bottom bar).
await page.locator('header button[aria-label="browse swarm runs"]').click();
// Wait for at least one row to render.
await page
  .waitForFunction(
    () => document.querySelectorAll('[role="dialog"] a').length > 0,
    null,
    { timeout: 10_000 },
  )
  .catch(() => console.log('[warn] no dropdown rows loaded'));
await page.waitForTimeout(800);

// Grab the dropdown content bounding box
const popover = await page
  .locator('[role="dialog"], [role="menu"]')
  .first()
  .evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  })
  .catch(() => null);
console.log('popover box:', popover);

// Grab each row's content
const rows = await page
  .locator('[role="dialog"] a, [role="dialog"] button, [role="menu"] a, [role="menu"] button')
  .evaluateAll((els) =>
    els.slice(0, 6).map((el) => ({
      width: Math.round(el.getBoundingClientRect().width),
      text: el.innerText.replace(/\n/g, ' | ').trim().slice(0, 300),
    })),
  );
console.log('\nfirst rows:');
for (const r of rows) console.log(' ', r);

await page.screenshot({ path: '/tmp/runs-dropdown.png', fullPage: false });
console.log('\nscreenshot: /tmp/runs-dropdown.png');
await browser.close();
