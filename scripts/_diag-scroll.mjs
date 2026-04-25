import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const port = readFileSync('.dev-port', 'utf8').trim();
const url = `http://localhost:${port}/?swarmRun=run_modm7vsw_uxxy6b`;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Probe scroll state at multiple time points to see when content settles
// vs when we stop sticking to the bottom.
const samples = [];
for (const wait of [3000, 8000, 13000, 18000, 25000]) {
  await page.waitForTimeout(wait - (samples.at(-1)?.elapsed ?? 0));
  const state = await page.evaluate(() => {
    const el = document.querySelector('div.bg-grid-dots');
    if (!el) return null;
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    };
  });
  samples.push({ elapsed: wait, ...state });
}
console.log(JSON.stringify(samples, null, 2));

// Walk up the DOM tree from scroll container — find every ancestor with overflow
const ancestors = await page.evaluate(() => {
  let el = document.querySelector('div.bg-grid-dots');
  const chain = [];
  while (el) {
    const cs = window.getComputedStyle(el);
    chain.push({
      tag: el.tagName,
      cls: el.className?.slice(0, 80) ?? '',
      overflowY: cs.overflowY,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      isScrolling: el.scrollHeight > el.clientHeight && (cs.overflowY === 'auto' || cs.overflowY === 'scroll'),
    });
    el = el.parentElement;
  }
  return chain;
});
console.log('\n--- DOM ancestor chain ---');
console.log(JSON.stringify(ancestors, null, 2));

await browser.close();
