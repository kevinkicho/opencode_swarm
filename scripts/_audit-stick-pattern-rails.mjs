// Audit: stick-to-bottom + latest button across pattern-specific rails.
// Loads a blackboard run, clicks the `contracts` main-view tab, samples
// the rail's scroll state at multiple time points, asserts at-bottom.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const port = readFileSync('.dev-port', 'utf8').trim();
const url = `http://localhost:${port}/?swarmRun=run_modm7vsw_uxxy6b`;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15_000);

// Click 'contracts' tab in main view
await page.evaluate(() => {
  const sec = document.querySelector('section.pl-3');
  const buttons = sec ? Array.from(sec.querySelectorAll('button')) : [];
  const t = buttons.find(b => (b.textContent ?? '').trim().toLowerCase() === 'contracts');
  if (t) t.click();
});
await page.waitForTimeout(2000);

// Find the contracts ul (the scrollable list)
const samples = [];
for (const wait of [2000, 5000, 10000, 15000]) {
  if (samples.length > 0) {
    await page.waitForTimeout(wait - samples.at(-1).elapsed);
  } else {
    await page.waitForTimeout(wait);
  }
  const state = await page.evaluate(() => {
    // Look for any flex-1 overflow-y-auto inside the main view section
    const sec = document.querySelector('section.pl-3');
    if (!sec) return { found: false };
    const scrollEl = sec.querySelector('ul.overflow-y-auto, div.overflow-y-auto');
    if (!scrollEl) return { found: false };
    return {
      found: true,
      scrollTop: Math.round(scrollEl.scrollTop),
      scrollHeight: Math.round(scrollEl.scrollHeight),
      clientHeight: Math.round(scrollEl.clientHeight),
      gap: Math.round(scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight),
      atBottom: Math.abs(scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) < 50,
    };
  });
  samples.push({ elapsed: wait, ...state });
}
console.log(JSON.stringify(samples, null, 2));
// Also check the latest button visibility
const btnState = await page.evaluate(() => {
  const sec = document.querySelector('section.pl-3');
  if (!sec) return { found: false };
  const btn = sec.querySelector('button[aria-label="scroll to latest"]');
  if (!btn) return { found: false };
  const r = btn.getBoundingClientRect();
  const style = window.getComputedStyle(btn);
  return {
    found: true,
    width: Math.round(r.width),
    visible: style.opacity !== '0' && r.width > 0,
    opacity: style.opacity,
  };
});
console.log('latest button:', JSON.stringify(btnState));
await browser.close();
