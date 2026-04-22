#!/usr/bin/env node
// Click a heat row, verify the drawer opens with a file-heat inspector body.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[page err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('button:has-text("heat")', { timeout: 20_000 });
await page.locator('button:has-text("heat")').first().click();
await page.waitForTimeout(800);

// Click the first heat row
const firstRow = page.locator('ul.list-none > li [role="button"]').first();
const rowCount = await firstRow.count();
console.log('heat rows present?', rowCount > 0);
if (rowCount === 0) {
  await browser.close();
  process.exit(1);
}
await firstRow.click();
await page.waitForTimeout(800);

// Drawer should now be open with FileHeatInspector content
const inspectorText = await page
  .locator('aside, [role="dialog"]')
  .allInnerTexts()
  .catch(() => []);

console.log('inspector content found in', inspectorText.length, 'containers');
for (const t of inspectorText.slice(0, 2)) {
  console.log('---');
  console.log(t.slice(0, 500));
}

// Look for file-heat-specific markers
const hasHeatHeader = await page
  .locator('text=/file · heat/i')
  .count()
  .catch(() => 0);
const hasTouchedBy = await page
  .locator('text=/touched by/i')
  .count()
  .catch(() => 0);
const hasAbsolute = await page
  .locator('text=/^absolute$/i')
  .count()
  .catch(() => 0);
console.log('\nmarkers:');
console.log('  "file · heat" label:', hasHeatHeader > 0);
console.log('  "touched by" label:', hasTouchedBy > 0);
console.log('  "absolute" label:', hasAbsolute > 0);

await page.screenshot({ path: '/tmp/heat-click.png', fullPage: false });
console.log('\nscreenshot: /tmp/heat-click.png');
await browser.close();
