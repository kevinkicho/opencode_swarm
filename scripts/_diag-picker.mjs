import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const port = readFileSync('.dev-port', 'utf8').trim();
const url = `http://localhost:${port}/?swarmRun=run_modm7vsw_uxxy6b`;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15_000);
await page.click('button[aria-label="browse swarm runs"]');
await page.waitForTimeout(2000);
const info = await page.evaluate(() => {
  const allLis = Array.from(document.querySelectorAll('li.group'));
  const rowSamples = allLis.slice(0, 5).map(li => ({
    cls: (li.className ?? '').slice(0, 80),
    text: (li.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
    hasRoundedFull: !!li.querySelector('span.rounded-full'),
    roundedFullClasses: Array.from(li.querySelectorAll('span.rounded-full')).map(e => (e.className ?? '').slice(0, 80)),
  }));
  const allText = document.body.innerText;
  return {
    rowsFound: allLis.length,
    rowSamples,
    bodyContainsM7vsw: allText.includes('m7vsw'),
    bodyContainsXxy6b: allText.includes('xxy6b'),
    bodyContainsModm7vsw: allText.includes('modm7vsw'),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
