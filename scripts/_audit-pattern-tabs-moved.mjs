// Audit Item 4: pattern-specific tabs moved from LeftTabs → main view.
// Asserts that:
//   1. The 8 pattern tab labels do NOT appear in the LEFT-tabs row
//   2. They DO appear in the main-view runView toggle for matching pattern
//   3. Clicking 'contracts' in the runView toggle renders ContractsRail
//
// usage: node scripts/_audit-pattern-tabs-moved.mjs <runID>

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const runIDArg = process.argv[2];
if (!runIDArg) {
  console.error('usage: <runID>');
  process.exit(2);
}

const port = readFileSync('.dev-port', 'utf8').trim();
const url = `http://localhost:${port}/?swarmRun=${runIDArg}`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(15_000);

const PATTERN_LABELS = ['contracts', 'iterations', 'debate', 'roles', 'map', 'council', 'phases', 'strategy'];

// Locate the LeftTabs container (sidebar with bg-ink-850 sidebar-seam)
const leftTabLabels = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('section.sidebar-seam button span'));
  return tabs.map(s => (s.textContent ?? '').trim().toLowerCase()).filter(Boolean);
});

// Locate the main-view runView toggle (text-micro uppercase tracking-widest2 buttons in section.flex-1.pl-3)
const mainViewLabels = await page.evaluate(() => {
  const sec = document.querySelector('section.pl-3');
  if (!sec) return [];
  const buttons = Array.from(sec.querySelectorAll('button'));
  return buttons.map(b => (b.textContent ?? '').trim().toLowerCase()).filter(t => t && t.length < 20);
});

const leftHasPatternTab = PATTERN_LABELS.filter(p => leftTabLabels.includes(p));
const mainHasPatternTab = PATTERN_LABELS.filter(p => mainViewLabels.includes(p));

// Click 'contracts' in main view if available
let contractsRendered = false;
if (mainViewLabels.includes('contracts')) {
  await page.evaluate(() => {
    const sec = document.querySelector('section.pl-3');
    const buttons = sec ? Array.from(sec.querySelectorAll('button')) : [];
    const t = buttons.find(b => (b.textContent ?? '').trim().toLowerCase() === 'contracts');
    if (t) t.click();
  });
  await page.waitForTimeout(1500);
  // Check that the main view now shows contracts content (the contracts rail header)
  contractsRendered = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return text.includes('contracts') && text.includes('met') || text.includes('unmet') || text.includes('verdict');
  });
}

console.log(JSON.stringify({
  leftTabLabels,
  mainViewLabels,
  leftHasPatternTab,
  mainHasPatternTab,
  contractsRendersInMain: contractsRendered,
  errors: errs.slice(0, 5),
}, null, 2));

await browser.close();
