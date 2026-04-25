// Visual-fix audit. Loads the page in headless Chromium and runs
// targeted assertions for each "SHIPPED-UNVERIFIED" item from
// IMPLEMENTATION_PLAN Phase 7. Output is per-item PASS / FAIL /
// INDETERMINATE with the specific evidence used.
//
//   node scripts/_audit-visual-fixes.mjs <runID>

import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const runIDArg = process.argv[2];
if (!runIDArg) {
  console.error('usage: _audit-visual-fixes.mjs <swarmRunID>');
  process.exit(2);
}

const port = readFileSync('.dev-port', 'utf8').trim();
const url = `http://localhost:${port}/?swarmRun=${runIDArg}`;

console.log(`[audit] loading ${url}\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`[console.error] ${m.text()}`);
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (err) {
  console.error(`[audit] navigation failed: ${err.message}`);
  await browser.close();
  process.exit(1);
}
// Wait for hydration + initial fetches to land
await page.waitForTimeout(20_000);

const results = [];

function record(id, label, status, evidence) {
  results.push({ id, label, status, evidence });
}

// ─── Q11: lane meter shows IN before OUT ──────────────────────────
{
  // Each lane's meter is rendered as adjacent spans; textContent
  // concatenates them as e.g. "in 5.6Mout 15k" (no space in raw).
  // The order check: does "in" appear BEFORE "out" within each meter?
  const laneTexts = await page.$$eval(
    '[class*="font-mono"][class*="tabular-nums"]',
    (els) => els.map((e) => e.textContent?.trim() ?? '').filter((t) => /^in\s/.test(t) || /^out\s/.test(t)),
  );
  const meterCombos = laneTexts.filter((t) => /^in\s.*out\s/.test(t));
  record(
    'Q11',
    'Lane meter IN-first then OUT',
    meterCombos.length > 0 ? 'PASS' : laneTexts.length === 0 ? 'INDETERMINATE' : 'FAIL',
    `combos=${meterCombos.length} sample=${JSON.stringify(meterCombos.slice(0, 3))}`,
  );
}

// ─── Q12 + Q14: run-anchor chip shows status label, not "RUN" ─────
{
  // Topbar root: <header> at top of layout. textContent strips tags but
  // keeps text. Status labels render in CAPS via uppercase tracking-widest2.
  const headerText = await page.evaluate(() => {
    const h = document.querySelector('header');
    return h?.innerText ?? '';
  });
  const hasStatusLabel = /\b(LIVE|ERROR|STALE|IDLE|DONE|UNKNOWN|QUEUED)\b/.test(headerText);
  // Old chip had "RUN <directive>"; new chip has just the status label.
  // We look for "RUN " followed by lowercase (the directive teaser starts
  // lowercase usually). Whitespace+caps after RUN means it's just a header
  // "RUN ANCHOR" inside the popover, not the chip text.
  const hasRunDirective = /\bRUN\s+[a-z]/.test(headerText);
  record(
    'Q12+Q14',
    'Run-anchor: status-only label',
    hasStatusLabel && !hasRunDirective ? 'PASS' : 'FAIL',
    `hasStatus=${hasStatusLabel} hasRunDirective=${hasRunDirective} headerText[0..200]=${JSON.stringify(headerText.slice(0, 200))}`,
  );
}

// ─── Q7: directive truncated to ~240px in topbar ─────────────────
{
  // The button immediately after the "swarm" eyebrow holds the title/directive.
  // We measure the bounding box width of any element whose innerText starts
  // with "Keep building the yahoo-finance" — if it's the truncated chip it
  // should be ≤ ~260px wide (240 + padding).
  const widths = await page.$$eval(
    'button, span',
    (els) => {
      const out = [];
      for (const e of els) {
        const t = (e.textContent ?? '').trim();
        if (t.startsWith('Keep building the yahoo-finance')) {
          const r = e.getBoundingClientRect();
          out.push({ width: Math.round(r.width), tag: e.tagName, len: t.length });
        }
      }
      return out;
    },
  );
  const maxWidth = widths.length > 0 ? Math.max(...widths.map((w) => w.width)) : 0;
  record(
    'Q7',
    'Directive truncated to ≤260px',
    maxWidth > 0 && maxWidth <= 260 ? 'PASS' : maxWidth === 0 ? 'INDETERMINATE' : 'FAIL',
    `widest matching element: ${maxWidth}px (samples: ${JSON.stringify(widths)})`,
  );
}

// ─── Q1+Q8: stick-to-bottom on entry ─────────────────────────────
{
  // Find the timeline scroll container. Per swarm-timeline.tsx it's the
  // "flex-1 overflow-auto bg-grid-dots" div.
  const scrollState = await page.evaluate(() => {
    const el = document.querySelector('div.bg-grid-dots');
    if (!el) return { found: false };
    return {
      found: true,
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: Math.round(el.scrollHeight),
      clientHeight: Math.round(el.clientHeight),
      atBottom:
        Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 50,
    };
  });
  record(
    'Q1+Q8',
    'Timeline stick-to-bottom on entry',
    !scrollState.found
      ? 'INDETERMINATE (no timeline container)'
      : scrollState.atBottom
        ? 'PASS'
        : 'FAIL',
    JSON.stringify(scrollState),
  );
}

// ─── Q2: latest button visibility (when not at bottom) ───────────
{
  // Scroll to top, then check if the button is in the DOM and visible.
  const result = await page.evaluate(async () => {
    const el = document.querySelector('div.bg-grid-dots');
    if (!el) return { found: false };
    el.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 300));
    const btn = document.querySelector('button[aria-label="scroll to latest"]');
    if (!btn) return { found: true, buttonInDom: false };
    const r = btn.getBoundingClientRect();
    const style = window.getComputedStyle(btn);
    return {
      found: true,
      buttonInDom: true,
      visible: style.opacity !== '0' && style.visibility !== 'hidden' && r.width > 0,
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
    };
  });
  record(
    'Q2',
    'Latest button visible when scrolled to top',
    !result.found
      ? 'INDETERMINATE (no scroll container)'
      : !result.buttonInDom
        ? 'FAIL (button not in DOM at all)'
        : result.visible
          ? 'PASS'
          : 'FAIL',
    JSON.stringify(result),
  );
}

// ─── Q6: roster status chips ─────────────────────────────────────
{
  // Switch to roster tab if not already
  const rosterClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const t = buttons.find((b) => (b.textContent ?? '').trim().toLowerCase() === 'roster');
    if (t) {
      t.click();
      return true;
    }
    return false;
  });
  await page.waitForTimeout(500);
  // Look for status text-chips inside roster rows. Each row has the
  // status label (idle/working/error/etc.) — check at least one has it.
  const rosterText = await page.$$eval(
    'li button span',
    (spans) =>
      spans
        .map((s) => (s.textContent ?? '').trim().toLowerCase())
        .filter((t) => ['idle', 'working', 'thinking', 'waiting', 'error', 'done', 'paused'].includes(t)),
  );
  record(
    'Q6',
    'Roster row status chip text label',
    rosterText.length > 0 ? 'PASS' : 'FAIL',
    `tab-clicked=${rosterClicked} found-status-labels=${JSON.stringify(rosterText.slice(0, 5))}`,
  );
}

// ─── Q9: parts filter shows all 12 + multi-select checkboxes ─────
{
  // Find the parts button and click to open the popover
  const opened = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const t = buttons.find((b) => /^parts(\s|·|$)/i.test((b.textContent ?? '').trim()));
    if (t) {
      t.click();
      return true;
    }
    return false;
  });
  await page.waitForTimeout(800);
  const partRows = await page.$$eval('button[aria-pressed]', (els) =>
    els.map((e) => (e.getAttribute('aria-label') ?? '').replace(/^toggle\s+/i, '').toLowerCase()).filter(Boolean),
  );
  record(
    'Q9',
    'Parts filter multi-select + 12 types',
    !opened
      ? 'INDETERMINATE (parts button not found / not on timeline view)'
      : partRows.length >= 10
        ? 'PASS'
        : 'FAIL',
    `popover-opened=${opened} part-rows=${partRows.length} sample=${JSON.stringify(partRows.slice(0, 6))}`,
  );
}

// ─── Role chip on lane header ────────────────────────────────────
{
  const labels = await page.$$eval('span[title^="role: "]', (els) =>
    els.map((e) => (e.textContent ?? '').trim().toLowerCase()),
  );
  record(
    'role-chip',
    'Lane header shows role label (planner/worker-N)',
    labels.length > 0 ? 'PASS' : 'FAIL',
    `count=${labels.length} sample=${JSON.stringify(labels.slice(0, 5))}`,
  );
}

// ─── Q10: react-scan disabled by default ─────────────────────────
{
  // react-scan injects a fixed-position toolbar div with a specific class.
  // When disabled, no overlay outlines should be visible. We can't easily
  // detect "outlines absent" but we CAN detect if scan is in 'enabled'
  // state via window globals.
  const scanState = await page.evaluate(() => {
    const w = window;
    return {
      scanGlobal: typeof w.__REACT_SCAN__ !== 'undefined' ? 'present' : 'absent',
      // overlay canvas if outlines were active
      overlayCanvas: !!document.querySelector('canvas[data-react-scan]'),
    };
  });
  record(
    'Q10',
    'react-scan starts disabled',
    !scanState.overlayCanvas ? 'PASS' : 'FAIL',
    JSON.stringify(scanState),
  );
}

// ─── Q15: picker rows have NO status dot ──────────────────────────
{
  // Click the runs picker button
  const pickerOpened = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const t = buttons.find((b) => /^runs?(\s|$)/i.test((b.textContent ?? '').trim()));
    if (t) {
      t.click();
      return true;
    }
    return false;
  });
  await page.waitForTimeout(1500);
  const pickerInfo = await page.evaluate(() => {
    // Picker rows are <li> with text like "ERROR" / "LIVE" / "STALE" early.
    // Check first 5 rows for any leading rounded-full dot.
    const rows = Array.from(document.querySelectorAll('li.group')).slice(0, 5);
    if (rows.length === 0) return { pickerRows: 0 };
    let dotsFound = 0;
    for (const r of rows) {
      // The status column (per the picker code) used to wrap a
      // `<span class='w-1.5 h-1.5 rounded-full'>` dot. We look for any
      // such element inside the row.
      const dot = r.querySelector('span.w-1\\.5.h-1\\.5.rounded-full');
      if (dot) dotsFound += 1;
    }
    return { pickerRows: rows.length, dotsFound };
  });
  record(
    'Q15',
    'Picker row status has NO dot',
    !pickerOpened
      ? 'INDETERMINATE (picker button not found)'
      : pickerInfo.pickerRows === 0
        ? 'INDETERMINATE (no rows rendered)'
        : pickerInfo.dotsFound === 0
          ? 'PASS'
          : 'FAIL',
    JSON.stringify(pickerInfo),
  );
}

// ─── Q16: target run appears in picker listview ───────────────────
{
  // Picker uses idTail() so full ID won't appear in text. Search for the
  // last 5 chars (idTail typical length).
  const tail = runIDArg.slice(-5);
  const found = await page.evaluate((needle) => {
    return document.body.innerText.includes(needle);
  }, tail);
  record(
    'Q16',
    'Target run appears in picker listview',
    found ? 'PASS' : 'FAIL',
    `searched-for-tail=${tail} (full=${runIDArg})`,
  );
}

// ─── Print summary ───────────────────────────────────────────────
console.log('\n=== AUDIT RESULTS ===\n');
const w = (s, n) => (s + ' '.repeat(n)).slice(0, n);
console.log(w('id', 12), w('item', 44), w('status', 14), 'evidence');
console.log('-'.repeat(120));
for (const r of results) {
  console.log(w(r.id, 12), w(r.label, 44), w(r.status, 14), r.evidence.slice(0, 200));
}
console.log('');

if (consoleErrors.length > 0) {
  console.log(`\n=== console errors during audit (${consoleErrors.length}) ===`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
}

await browser.close();
