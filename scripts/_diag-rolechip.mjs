import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const port = readFileSync('.dev-port', 'utf8').trim();
const url = `http://localhost:${port}/?swarmRun=run_modm7vsw_uxxy6b`;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(15_000);

// 1. Confirm we're on timeline view (not board/cards)
const view = await page.evaluate(() => {
  const sec = document.querySelector('section.bg-ink-800');
  return sec ? sec.querySelector('span.text-fog-600')?.textContent : 'no section';
});

// 2. Look for ANY role-related text in lane headers
const laneInfo = await page.evaluate(() => {
  // Lane headers should be inside the timeline section. Each lane has the
  // agent's name + chip area.
  const titleSpans = Array.from(document.querySelectorAll('span[title*="role"]'));
  const allTitles = Array.from(document.querySelectorAll('[title]'))
    .map(e => e.getAttribute('title'))
    .filter(t => t && t.includes('role'));
  return {
    titleSpansWithRole: titleSpans.length,
    allTitlesWithRole: allTitles.slice(0, 5),
  };
});

// 3. Check what providerBadge / chip is showing for each lane
const laneChips = await page.evaluate(() => {
  // Find all elements with tracking-widest2 (the chip class) and check
  // if any contain "ollama" or look like provider badges.
  const chips = Array.from(document.querySelectorAll('span'));
  const provider = chips.filter(e => /^(ollama|opencode-go|opencode|opencode-zen)$/.test((e.textContent ?? '').trim()));
  const role = chips.filter(e => /^(planner|worker-\d|orchestrator|judge|generator-\d|critic|member-\d|mapper-\d|synthesizer)$/.test((e.textContent ?? '').trim()));
  return {
    providerChips: provider.length,
    providerSample: provider.slice(0, 5).map(e => e.textContent),
    roleChips: role.length,
    roleSample: role.slice(0, 5).map(e => e.textContent),
  };
});

// 4. Confirm boardRoleNames populates by looking at the first lane's structure
const firstLaneStructure = await page.evaluate(() => {
  const lanes = document.querySelectorAll('button[style*="width"]');
  if (lanes.length < 2) return { lanes: lanes.length };
  return {
    lanes: lanes.length,
    firstLaneInnerText: (lanes[1].textContent ?? '').slice(0, 200),
  };
});

console.log(JSON.stringify({ view, laneInfo, laneChips, firstLaneStructure }, null, 2));
await browser.close();
