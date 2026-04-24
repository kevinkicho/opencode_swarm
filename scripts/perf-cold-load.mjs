// Cold-load benchmark — measures what the USER actually experiences from
// URL input to a fully-populated UI. Targets the question my tab-switch
// benchmark missed: "why does it take 30+ seconds before I can interact?"
//
//   npm run perf:cold                  → dev (.dev-port), root /
//   npm run perf:cold -- <runID>       → dev with a specific swarmRun
//   PROD=1 npm run perf:cold           → prod on :3100
//
// What it reports:
//   - TTFB / FCP / LCP / DOMContentLoaded / load
//   - Time until specific UI elements are non-empty ("ready for interaction")
//   - Every network request with duration, grouped by host + path prefix
//   - Slowest N individual requests
//   - Waterfall of requests fired in the first 30 seconds
//
// Does NOT use networkidle as a wait condition — that's fatal here because
// the app holds open SSE connections indefinitely. Instead waits for
// semantic UI readiness signals.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const PROD = process.env.PROD === '1';
const runIDArg = process.argv[2] ?? '';

function resolveUrl() {
  const base = PROD
    ? 'http://localhost:3100'
    : (() => {
        if (!existsSync('.dev-port')) {
          console.error('[perf-cold] .dev-port missing — run `npm run dev` first');
          process.exit(1);
        }
        return `http://localhost:${readFileSync('.dev-port', 'utf8').trim()}`;
      })();
  return runIDArg ? `${base}/?swarmRun=${runIDArg}` : `${base}/`;
}

const url = resolveUrl();
const MODE = PROD ? 'prod' : 'dev';
console.log(`[perf-cold] measuring ${url} (mode=${MODE})\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Track every request. Playwright's request event fires before the request
// is sent; response gives us the status; requestfinished gives us the
// final timing. We key by URL + method to pair the three.
const reqs = new Map();
page.on('request', (req) => {
  reqs.set(req, { startedAt: Date.now(), url: req.url(), method: req.method() });
});
page.on('response', (res) => {
  const r = reqs.get(res.request());
  if (r) {
    r.status = res.status();
    r.respondedAt = Date.now();
  }
});
page.on('requestfinished', async (req) => {
  const r = reqs.get(req);
  if (!r) return;
  r.finishedAt = Date.now();
  try {
    const timing = req.timing();
    r.timing = {
      domainLookup: Math.max(0, timing.domainLookupEnd - timing.domainLookupStart),
      connect: Math.max(0, timing.connectEnd - timing.connectStart),
      request: Math.max(0, timing.requestStart - timing.connectEnd),
      response: Math.max(0, timing.responseEnd - timing.responseStart),
    };
  } catch {
    // non-finished requests throw on timing() — ignore
  }
});
page.on('requestfailed', (req) => {
  const r = reqs.get(req);
  if (r) {
    r.failed = true;
    r.finishedAt = Date.now();
    r.failureText = req.failure()?.errorText;
  }
});

// Before navigation, install a marker for paint timing.
await page.addInitScript(() => {
  // @ts-expect-error
  window.__navStart = performance.now();
});

const navStart = Date.now();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (err) {
  console.error(`[perf-cold] navigation failed: ${err.message}`);
  await browser.close();
  process.exit(1);
}
const dclAt = Date.now() - navStart;

// Collect paint timings + web vitals as they arrive, via page eval.
async function snapshotPaint() {
  return page.evaluate(() => {
    const paint = performance.getEntriesByType('paint');
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      // @ts-expect-error
      navStart: window.__navStart,
      TTFB: nav ? nav.responseStart : null,
      DCL: nav ? nav.domContentLoadedEventEnd : null,
      load: nav ? nav.loadEventEnd : null,
      FCP: paint.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null,
      FP: paint.find((p) => p.name === 'first-paint')?.startTime ?? null,
    };
  });
}

// Wait for specific UI readiness signals. Each returns the elapsed time
// from navStart, or null if it never appeared within the budget.
async function waitForSelector(selector, budgetMs = 30_000) {
  try {
    const before = Date.now();
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: budgetMs });
    return Date.now() - navStart;
  } catch {
    return null;
  }
}

// Target selectors — distinct UI elements that signal "data arrived."
// Tuned to pages that have a swarmRun active (the user's actual scenario).
// For root /, most won't appear; that's expected.
const readinessTargets = [
  { label: 'any button', sel: 'button' },
  { label: 'topbar', sel: 'header, [role="banner"], nav' },
  { label: 'left-tabs any tab', sel: 'button:has-text("plan"), button:has-text("roster"), button:has-text("board"), button:has-text("heat")' },
  { label: 'view switcher', sel: 'button:has-text("timeline"), button:has-text("cards")' },
  { label: 'board item row', sel: '[class*="board-rail"] li, ul li:has([data-status])' },
  { label: 'timeline event', sel: '[class*="timeline"] li, [class*="swarm-timeline"] > *' },
  { label: 'first counted number', sel: '[class*="tabular-nums"]' },
];

console.log('=== READINESS (ms from nav start) ===');
const readiness = [];
for (const t of readinessTargets) {
  const elapsed = await waitForSelector(t.sel, 20_000);
  readiness.push({ label: t.label, sel: t.sel, elapsed });
  console.log(`  ${t.label.padEnd(24)} ${elapsed !== null ? `${elapsed}ms` : 'not found within 20s'}`);
}

// Give the page a final beat to let SSE / deferred fetches settle,
// then snapshot metrics.
await page.waitForTimeout(3000);
const paint = await snapshotPaint();

console.log('\n=== PAINT + NAV ===');
console.log(`  TTFB                 ${paint.TTFB != null ? `${Math.round(paint.TTFB)}ms` : '—'}`);
console.log(`  First paint          ${paint.FP != null ? `${Math.round(paint.FP)}ms` : '—'}`);
console.log(`  First contentful     ${paint.FCP != null ? `${Math.round(paint.FCP)}ms` : '—'}`);
console.log(`  DOM content loaded   ${paint.DCL != null ? `${Math.round(paint.DCL)}ms` : '—'}`);
console.log(`  Window load          ${paint.load != null ? `${Math.round(paint.load)}ms` : '—'}`);

// Analyze requests. Group by path-prefix + host so the summary reads
// "/api/opencode/session/... 15 requests, total 12000ms" rather than
// listing 15 individual URLs.
const reqList = [...reqs.values()].filter((r) => r.respondedAt);
reqList.sort((a, b) => a.startedAt - b.startedAt);

function pathKey(u) {
  try {
    const p = new URL(u);
    const host = p.host;
    // Collapse /api/opencode/session/<id>/... → /api/opencode/session/*/...
    // and /api/swarm/run/<id>/... → /api/swarm/run/*/...
    const path = p.pathname
      .replace(/\/ses_[A-Za-z0-9]+/g, '/ses_*')
      .replace(/\/run_[A-Za-z0-9_]+/g, '/run_*')
      .replace(/\/[0-9a-f-]{16,}/g, '/*')
      .replace(/\?.*/, '');
    return `${host}${path}`;
  } catch {
    return u;
  }
}

const groups = new Map();
for (const r of reqList) {
  const k = pathKey(r.url);
  const g = groups.get(k) ?? { key: k, count: 0, totalMs: 0, maxMs: 0, failed: 0, firstStart: Infinity, lastEnd: 0, statuses: new Map() };
  const dur = (r.finishedAt ?? r.respondedAt) - r.startedAt;
  g.count += 1;
  g.totalMs += dur;
  g.maxMs = Math.max(g.maxMs, dur);
  if (r.failed) g.failed += 1;
  g.firstStart = Math.min(g.firstStart, r.startedAt - navStart);
  g.lastEnd = Math.max(g.lastEnd, (r.finishedAt ?? r.respondedAt) - navStart);
  g.statuses.set(r.status ?? 0, (g.statuses.get(r.status ?? 0) ?? 0) + 1);
  groups.set(k, g);
}

console.log('\n=== REQUESTS BY PATH (grouped, sorted by total time) ===');
const sortedGroups = [...groups.values()].sort((a, b) => b.totalMs - a.totalMs);
console.log(`${'path'.padEnd(64)} ${'count'.padStart(6)} ${'total'.padStart(7)} ${'avg'.padStart(5)} ${'max'.padStart(5)} ${'window'.padStart(12)}`);
for (const g of sortedGroups.slice(0, 25)) {
  const avg = Math.round(g.totalMs / g.count);
  console.log(
    `${g.key.length > 62 ? '…' + g.key.slice(-61) : g.key.padEnd(64)} ${g.count.toString().padStart(6)} ${g.totalMs.toString().padStart(5)}ms ${avg.toString().padStart(3)}ms ${Math.round(g.maxMs).toString().padStart(3)}ms ${`${Math.round(g.firstStart)}..${Math.round(g.lastEnd)}ms`.padStart(12)}`,
  );
}

// Show the slowest individual requests — the pathological ones.
const slowest = [...reqList].sort((a, b) => {
  const da = (a.finishedAt ?? a.respondedAt) - a.startedAt;
  const db = (b.finishedAt ?? b.respondedAt) - b.startedAt;
  return db - da;
});

console.log('\n=== 12 SLOWEST INDIVIDUAL REQUESTS ===');
for (const r of slowest.slice(0, 12)) {
  const dur = (r.finishedAt ?? r.respondedAt) - r.startedAt;
  const rel = r.startedAt - navStart;
  const u = r.url.length > 85 ? '…' + r.url.slice(-82) : r.url;
  console.log(`  +${String(rel).padStart(5)}ms  ${dur.toString().padStart(5)}ms  [${r.status ?? '-'}]  ${u}`);
}

// Fire-too-early check: requests that started in the first 2 seconds.
// If any are for /session/<id>/message or /session/<id>/diff BEFORE the
// UI is meant to know the session ID, it means the hook fan-out is
// blocking initial render.
console.log('\n=== REQUEST FAN-OUT IN FIRST 5 SECONDS ===');
const early = reqList.filter((r) => r.startedAt - navStart <= 5000);
console.log(`  ${early.length} requests fired within 5s of nav start`);
const firstSecond = reqList.filter((r) => r.startedAt - navStart <= 1000);
console.log(`  ${firstSecond.length} requests fired within 1s`);

mkdirSync('.perf', { recursive: true });
const out = {
  url,
  mode: MODE,
  dclAt,
  paint,
  readiness,
  groups: sortedGroups.map((g) => ({
    key: g.key,
    count: g.count,
    totalMs: g.totalMs,
    maxMs: g.maxMs,
    failed: g.failed,
    firstStart: g.firstStart,
    lastEnd: g.lastEnd,
  })),
  slowest: slowest.slice(0, 30).map((r) => ({
    url: r.url,
    startRel: r.startedAt - navStart,
    durationMs: (r.finishedAt ?? r.respondedAt) - r.startedAt,
    status: r.status,
    failed: !!r.failed,
  })),
  capturedAt: new Date().toISOString(),
};
const path = `.perf/cold-load-${MODE}-${Date.now()}.json`;
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`\n[perf-cold] report saved to ${path}`);

await browser.close();
