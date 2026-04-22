#!/usr/bin/env node
// Visual smoke — loads a run URL, switches to the heat tab, dumps DOM +
// computed styles for the first couple of rows. Lets me verify
// truncate-left / seam / tab-width behavior without waiting for the
// user to screenshot. Prints JSON-ish output.
//
// usage:
//   node scripts/_visual_check.mjs <url>
//   (defaults to http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy)

import { chromium } from 'playwright';

const url =
  process.argv[2] ??
  'http://localhost:49187/?swarmRun=run_moan1uee_z4y2wy';

const browser = await chromium.launch({ headless: true });
const viewportW = Number(process.env.VIEW_W ?? 1280);
const page = await browser.newPage({ viewport: { width: viewportW, height: 900 } });
console.log('viewport:', viewportW);

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[browser]', msg.text());
});

// 'load' not 'networkidle' — the run view keeps SSE streams open so
// networkidle never fires. 'load' fires when the initial document +
// its synchronous resources are in.
await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
// Give React time to hydrate and live-data hooks to render the tab bar.
await page.waitForSelector('button:has-text("heat")', { timeout: 20_000 });

// Click the heat tab (text="heat" button in the tab row)
const heatTab = page.locator('button:has-text("heat")').first();
const heatCount = await heatTab.count();
console.log('heat tab present?', heatCount > 0);

if (heatCount > 0) {
  await heatTab.click();
  await page.waitForTimeout(500);

  // Find heat rows — truncate-left class should be in use
  const rows = await page.locator('ul.list-none > li').evaluateAll((els) =>
    els.slice(0, 3).map((el) => {
      const truncEl = el.querySelector('.truncate-left');
      const pathEl = el.querySelector('div[class*="flex"][class*="items-baseline"]');
      const result = {
        rowInnerText: el.innerText.slice(0, 200),
        hasTruncateLeft: !!truncEl,
      };
      if (truncEl) {
        const cs = getComputedStyle(truncEl);
        result.truncateLeftStyles = {
          display: cs.display,
          direction: cs.direction,
          overflow: cs.overflow,
          textOverflow: cs.textOverflow,
          whiteSpace: cs.whiteSpace,
          width: Math.round(truncEl.getBoundingClientRect().width) + 'px',
          scrollWidth: truncEl.scrollWidth + 'px',
        };
      }
      if (pathEl) {
        result.pathContainerBox = {
          width: Math.round(pathEl.getBoundingClientRect().width) + 'px',
        };
      }
      return result;
    }),
  );
  console.log('\n--- first 3 heat rows ---');
  for (const r of rows) console.log(JSON.stringify(r, null, 2));
}

// Seam check
const seamStyles = await page
  .locator('section.sidebar-seam')
  .first()
  .evaluate((el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { boxShadow: cs.boxShadow, width: Math.round(el.getBoundingClientRect().width) + 'px' };
  })
  .catch(() => null);
console.log('\n--- sidebar seam ---');
console.log(JSON.stringify(seamStyles, null, 2));

await page.screenshot({
  path: '/tmp/visual-check.png',
  fullPage: false,
});
console.log('\nscreenshot: /tmp/visual-check.png');

await browser.close();
