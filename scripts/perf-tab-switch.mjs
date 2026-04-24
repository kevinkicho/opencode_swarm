// Headless Playwright benchmark for tab-switch responsiveness.
//
//   npm run perf:tabs              → uses the dev server, first available swarmRun
//   npm run perf:tabs <runID>      → uses a specific swarmRun
//   PROD=1 npm run perf:tabs       → uses `next start` on :3100 (must be running)
//
// What it measures per tab-click:
//   - elapsedMs      : wall-clock from click to 500ms of main-thread stillness
//   - longTasks      : count of 'longtask' PerformanceObserver entries (>50ms blocking)
//   - longTaskMs     : total ms of main-thread blocking
//   - domNodes       : DOM node count after the click settles
//   - Δ DOM          : DOM node delta since the previous tab
//
// Also captures in-browser [profiler] and [web-vitals] console logs (the
// streams our components emit via browser console.log).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PROD = process.env.PROD === '1';
const runIDArg = process.argv[2] ?? '';

function resolveUrl() {
  if (PROD) {
    const base = 'http://localhost:3100';
    return runIDArg ? `${base}/?swarmRun=${runIDArg}` : `${base}/`;
  }
  if (!existsSync('.dev-port')) {
    console.error('[perf-tabs] .dev-port missing — run `npm run dev` first');
    process.exit(1);
  }
  const port = readFileSync('.dev-port', 'utf8').trim();
  const base = `http://localhost:${port}`;
  return runIDArg ? `${base}/?swarmRun=${runIDArg}` : `${base}/`;
}

const url = resolveUrl();
const MODE = PROD ? 'prod' : 'dev';

console.log(`[perf-tabs] profiling ${url} (mode=${MODE})\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Capture [profiler], [web-vitals], [lazy-with-retry] lines from browser console.
const consoleLog = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (
    text.startsWith('[web-vitals]') ||
    text.startsWith('[profiler]') ||
    text.startsWith('[lazy-with-retry]')
  ) {
    consoleLog.push({ t: Date.now(), level: msg.type(), text });
  }
});
page.on('pageerror', (err) => {
  consoleLog.push({ t: Date.now(), level: 'error', text: `[pageerror] ${err.message}` });
});

// PerformanceObserver for longtasks runs BEFORE our app's scripts, thanks
// to addInitScript. The observer buffers entries into window.__longTasks.
await page.addInitScript(() => {
  // @ts-expect-error
  window.__longTasks = [];
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // @ts-expect-error
        window.__longTasks.push({ start: e.startTime, dur: e.duration });
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {
    // Some environments don't support longtask; ignore and report 0.
  }
});

const navStart = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
// Let the Suspense boundary / Next.js hydrate fully + any first SSE tick.
await page.waitForTimeout(2500);
const initialLoadMs = Date.now() - navStart;

async function metricsSnapshot() {
  return page.evaluate(() => ({
    // @ts-expect-error
    longTasks: (window.__longTasks || []).length,
    // @ts-expect-error
    longTaskTotalMs: (window.__longTasks || []).reduce((s, t) => s + t.dur, 0),
    domNodes: document.querySelectorAll('*').length,
  }));
}

async function resetLongTasks() {
  // @ts-expect-error
  await page.evaluate(() => { window.__longTasks = []; });
}

async function clickTabAndSettle(selector, label) {
  const exists = await page.locator(selector).count();
  if (!exists) return { label, skipped: true };
  await resetLongTasks();
  const before = await metricsSnapshot();
  const t0 = Date.now();
  try {
    await page.locator(selector).first().click({ timeout: 5000 });
  } catch (err) {
    return { label, error: String(err.message ?? err).slice(0, 80) };
  }
  // 500 ms wait for the main thread to quiet. Longtasks during this
  // window are what we want to count.
  await page.waitForTimeout(500);
  const t1 = Date.now();
  const after = await metricsSnapshot();
  return {
    label,
    elapsedMs: t1 - t0,
    longTasks: after.longTasks - before.longTasks,
    longTaskMs: after.longTaskTotalMs - before.longTaskTotalMs,
    domNodes: after.domNodes,
    nodeDelta: after.domNodes - before.domNodes,
  };
}

// Warmup initial state metrics.
const initial = await metricsSnapshot();

const results = [{
  label: 'INITIAL',
  elapsedMs: initialLoadMs,
  longTasks: initial.longTasks,
  longTaskMs: initial.longTaskTotalMs,
  domNodes: initial.domNodes,
  nodeDelta: initial.domNodes,
}];

// Left-tab buttons (exact text): plan, roster, board, heat.
// Right-side view buttons: timeline, cards, board.
// Use button:has-text() with text match; buttons are unique by label
// at the top of the left pane / view switcher row.
const leftTabs = ['plan', 'roster', 'board', 'heat'];
const viewTabs = ['timeline', 'cards', 'board'];

for (const t of leftTabs) {
  const r = await clickTabAndSettle(`button:has-text("${t}"):visible`, `L:${t}`);
  results.push(r);
}
for (const t of viewTabs) {
  const r = await clickTabAndSettle(`button:has-text("${t}"):visible`, `V:${t}`);
  results.push(r);
}

// Re-click each tab twice more to test warm-path — the first click may
// trigger lazy-chunk fetching; steady-state is what we care about.
const warmRuns = 2;
for (let i = 0; i < warmRuns; i++) {
  for (const t of leftTabs) {
    const r = await clickTabAndSettle(`button:has-text("${t}"):visible`, `L:${t}#${i + 2}`);
    results.push(r);
  }
}

console.log('=== TAB-SWITCH BENCHMARK ===');
console.log(`url: ${url}`);
console.log(`initial load: ${initialLoadMs}ms (domcontentloaded + networkidle + 2.5s settle)`);
console.log('');
console.log(`${'tab'.padEnd(12)} ${'elapsed'.padStart(9)} ${'LT'.padStart(4)} ${'LT ms'.padStart(8)} ${'DOM'.padStart(6)} ${'Δ DOM'.padStart(7)}`);
for (const r of results) {
  if (r.skipped) {
    console.log(`${r.label.padEnd(12)} (selector not present — tab hidden / no data)`);
  } else if (r.error) {
    console.log(`${r.label.padEnd(12)} ERROR: ${r.error}`);
  } else {
    console.log(
      [
        r.label.padEnd(12),
        `${r.elapsedMs}`.padStart(9),
        `${r.longTasks}`.padStart(4),
        `${Math.round(r.longTaskMs)}`.padStart(8),
        `${r.domNodes}`.padStart(6),
        `${r.nodeDelta >= 0 ? '+' : ''}${r.nodeDelta}`.padStart(7),
      ].join(' '),
    );
  }
}

console.log('');
console.log(`=== CAPTURED BROWSER CONSOLE LINES (${consoleLog.length}) ===`);
for (const line of consoleLog.slice(0, 40)) {
  console.log(`  ${line.text}`);
}
if (consoleLog.length > 40) {
  console.log(`  … ${consoleLog.length - 40} more lines (see saved report)`);
}

mkdirSync('.perf', { recursive: true });
const out = {
  url,
  mode: MODE,
  initialLoadMs,
  results,
  consoleLog,
  capturedAt: new Date().toISOString(),
};
const path = `.perf/tab-switch-${MODE}-${Date.now()}.json`;
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`\n[perf-tabs] report saved to ${path}`);

await browser.close();
