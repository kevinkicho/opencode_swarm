#!/usr/bin/env node
// Dump every tab button in LeftTabs — spot missing tabs fast.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

page.on('console', (m) => m.type() === 'error' && console.log('[browser err]', m.text()));
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForTimeout(3000); // give hooks time to fetch

// All buttons inside the tab bar (sticky header of LeftTabs)
const tabs = await page
  .locator('section.sidebar-seam > div:first-child button')
  .evaluateAll((els) =>
    els.map((el) => ({
      text: el.innerText.trim(),
      visible: el.getBoundingClientRect().width > 0,
      class: el.className.includes('molten') ? 'active' : 'inactive',
    })),
  );

console.log('tabs in header:');
for (const t of tabs) console.log(' ', JSON.stringify(t));

// Also grab the full main column contents visible when no tab selected = plan default
const leftRailHTML = await page
  .locator('section.sidebar-seam')
  .first()
  .innerHTML()
  .catch(() => 'no sidebar found');
console.log('\nleftrail snippet (first 500 chars):');
console.log(leftRailHTML.slice(0, 500));

await page.screenshot({ path: '/tmp/tabs-check.png', fullPage: false });
console.log('\nscreenshot: /tmp/tabs-check.png');
await browser.close();
