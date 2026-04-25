// Take a full-page screenshot of the app for preview/diagnostics. Saves
// to .perf/preview-<timestamp>.png so the file can be opened from the
// host or shared back. Also runs a quick readiness probe for the same
// targets perf:cold uses, so the script doubles as a sanity check that
// the app is hydrating + populating with data correctly.
//
//   node scripts/_preview-screenshot.mjs              # uses .dev-port + root /
//   node scripts/_preview-screenshot.mjs <runID>      # /?swarmRun=<runID>
//   PROD=1 node scripts/_preview-screenshot.mjs ...   # uses :3100 prod

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PROD = process.env.PROD === '1';
const runIDArg = process.argv[2] ?? '';

function resolveUrl() {
  const base = PROD
    ? 'http://localhost:3100'
    : `http://localhost:${readFileSync('.dev-port', 'utf8').trim()}`;
  return runIDArg ? `${base}/?swarmRun=${runIDArg}` : `${base}/`;
}

const url = resolveUrl();
console.log(`[preview] capturing ${url}\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Capture browser-side console for any errors during render.
const consoleErrors = [];
page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(`[console.error] ${msg.text()}`);
});

const t0 = Date.now();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (err) {
  console.error(`[preview] navigation failed: ${err.message}`);
  await browser.close();
  process.exit(1);
}
const navMs = Date.now() - t0;

// Wait long enough for the page's hydration to complete + initial SSE
// round-trip + per-session message fetches to come back. 4s isn't enough
// in dev; 20s gives the slowest pieces (workspace session list +
// per-session messages) time to land.
const waitMs = Number(process.env.WAIT_MS ?? 20_000);
console.log(`[preview] waiting ${waitMs}ms for page to hydrate + populate...`);
await page.waitForTimeout(waitMs);

// Snapshot some readiness facts.
const facts = await page.evaluate(() => ({
  domNodes: document.querySelectorAll('*').length,
  buttons: document.querySelectorAll('button').length,
  hasTopbar: !!document.querySelector('header, [class*="topbar"]'),
  bodyText: document.body.innerText.slice(0, 600),
}));

mkdirSync('.perf', { recursive: true });
const path = `.perf/preview-${Date.now()}.png`;
await page.screenshot({ path, fullPage: false });
console.log(`[preview] screenshot saved: ${path}`);
console.log(`[preview] nav→domcontentloaded: ${navMs}ms`);
console.log(`[preview] DOM nodes after 4s: ${facts.domNodes}`);
console.log(`[preview] buttons rendered: ${facts.buttons}`);
console.log(`[preview] topbar present: ${facts.hasTopbar}`);
console.log(`[preview] visible text (first 600 chars):`);
console.log(facts.bodyText.split('\n').slice(0, 30).map((l) => `  ${l}`).join('\n'));
if (consoleErrors.length > 0) {
  console.log(`\n[preview] page errors observed (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
} else {
  console.log('\n[preview] no page errors observed during render');
}

await browser.close();
