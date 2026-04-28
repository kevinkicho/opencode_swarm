// Record a live swarm run via Playwright recordVideo + walk the
// resulting .webm by extracting frames. Companion to the diagnostic
// workflow described in docs/POSTMORTEMS/2026-04-27-blackboard-
// recording-diagnostic.md.
//
// Usage:
//   node scripts/_record_run.mjs                   — defaults: blackboard, 6 min
//   node scripts/_record_run.mjs --pattern=council
//   node scripts/_record_run.mjs --minutes=10
//   node scripts/_record_run.mjs --no-spawn --run=run_xxx
//                                — record an existing live run instead
//
// Click selectors lifted from the original /tmp prototype to ARIA-
// friendly + exact-match shape. Each view-switch waits for the active-
// view chip to actually flip before moving on (the prototype clicked
// at fixed times and the .webm sometimes captured stale views).
//
// Output:
//   /tmp/swarm-recording/page@*.webm     — recorded session
//   /tmp/swarm-recording/run-id.txt      — swarmRunID
//   /tmp/swarm-recording/console.log     — browser console + pageerrors
//
// Frame extraction is a separate pass:
//   ffmpeg -i .../page.webm -vf "fps=1/5" /tmp/swarm-recording/frames/frame-%03d.png

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    }),
);

const PORT = readFileSync('.dev-port', 'utf8').trim();
const BASE = `http://localhost:${PORT}`;
const RECORD_DIR = '/tmp/swarm-recording';
const WATCH_MINUTES = parseInt(args.minutes ?? '6', 10);
const PATTERN = args.pattern ?? 'blackboard';
const NO_SPAWN = !!args['no-spawn'];

mkdirSync(RECORD_DIR, { recursive: true });

let RUN_ID;
if (NO_SPAWN) {
  RUN_ID = args.run;
  if (!RUN_ID) {
    console.error('--no-spawn requires --run=<swarmRunID>');
    process.exit(1);
  }
  console.log(`recording existing run ${RUN_ID}`);
} else {
  console.log(`spawning ${PATTERN} run via ${BASE}/api/swarm/run`);
  // Pattern-specific options. Most patterns share the same shape; a few
  // (map-reduce, critic-loop, debate-judge) accept extra knobs that the
  // validator scopes to that pattern.
  //
  // teamSize defaults: critic-loop pins exactly 2 (1 worker + 1 critic);
  // debate-judge needs ≥3 (judge + ≥2 generators). Other patterns float
  // around 3 unless the user overrides via --team-size.
  const teamSize = args['team-size']
    ? parseInt(args['team-size'], 10)
    : PATTERN === 'critic-loop'
      ? 2
      : 3;
  const body = {
    pattern: PATTERN,
    workspace: 'C:\\Users\\kevin\\Workspace\\kyahoofinance032926',
    directive:
      'Briefly survey the README. Each agent claims one specific README improvement and posts a finding to the board. Stop after 3 findings.',
    title: `recorded ${PATTERN} test · ${new Date().toISOString().slice(0, 10)}`,
    teamSize,
    teamModels: Array.from({ length: teamSize }, () => 'ollama/glm-5.1:cloud'),
    bounds: { costCap: 1, minutesCap: WATCH_MINUTES + 2 },
  };
  if (PATTERN === 'map-reduce' && args['synthesis-critic'] !== 'false') {
    body.enableSynthesisCritic = true;
  }
  if (PATTERN === 'critic-loop' && args['critic-iters']) {
    body.criticMaxIterations = parseInt(args['critic-iters'], 10);
  }
  if (PATTERN === 'debate-judge' && args['debate-rounds']) {
    body.debateMaxRounds = parseInt(args['debate-rounds'], 10);
  }
  const spawnRes = await fetch(`${BASE}/api/swarm/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const spawn = await spawnRes.json();
  if (!spawnRes.ok) {
    console.error(`spawn failed: ${spawnRes.status}`, spawn);
    process.exit(1);
  }
  RUN_ID = spawn.swarmRunID;
  console.log(`spawned: ${RUN_ID}`);
  console.log(`sessions:`, spawn.sessionIDs);
}
writeFileSync(join(RECORD_DIR, 'run-id.txt'), RUN_ID);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  recordVideo: { dir: RECORD_DIR, size: { width: 1600, height: 1000 } },
  viewport: { width: 1600, height: 1000 },
});
const page = await ctx.newPage();

const consoleLines = [];
page.on('console', (m) => {
  consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => {
  consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`);
});

console.log(`navigating to ${BASE}/?swarmRun=${RUN_ID}`);
await page.goto(`${BASE}/?swarmRun=${RUN_ID}`, { waitUntil: 'domcontentloaded' });

// View-switch helper. Clicks the toolbar button by exact text, then
// waits for the active-state class to actually appear on the same
// button. Without the wait, the .webm sometimes captures the prior
// view because the click was queued before React rendered the new
// state. Falls back gracefully if the view is unavailable for the
// current pattern (e.g., 'iterations' on a blackboard run) — logs and
// keeps going.
async function switchView(label) {
  const candidates = await page
    .locator(`button:text-is("${label}")`)
    .all();
  // Toolbar buttons sit inside a `<div className=... view ...>` cluster.
  // Pick the one whose closest ancestor mentions "VIEW" — the run-detail
  // toolbar. Fallback to first match if no explicit ancestor is found.
  let target;
  for (const c of candidates) {
    const inToolbar = await c.evaluate((el) => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i += 1) {
        if (p.textContent?.match(/^\s*VIEW\b/m)) return true;
        p = p.parentElement;
      }
      return false;
    });
    if (inToolbar) {
      target = c;
      break;
    }
  }
  target = target ?? candidates[0];
  if (!target) {
    console.log(`    ⚠ view "${label}" button not found — skipping`);
    return false;
  }
  // Active state = the button has the molten/amber accent class. Read
  // before + after click; if the class flipped on, we know the click
  // landed.
  const before = await target.evaluate((el) => el.className);
  await target.click({ force: true, timeout: 3000 }).catch(() => {});
  // Poll for class change up to 1.5s
  let after = before;
  for (let i = 0; i < 15; i += 1) {
    await page.waitForTimeout(100);
    after = await target.evaluate((el) => el.className).catch(() => before);
    if (after !== before) break;
  }
  if (after === before) {
    console.log(`    ⚠ view "${label}" click had no class effect`);
    return false;
  }
  // Bonus pad so the new view's render finishes before the next step.
  await page.waitForTimeout(800);
  return true;
}

const watchMs = WATCH_MINUTES * 60_000;
const startedAt = Date.now();
console.log(`watching for ${WATCH_MINUTES} minutes (${watchMs}ms)...`);

const interactions = [
  { atSec: 60, label: 'switch to chat', view: 'chat' },
  { atSec: 120, label: 'switch to timeline', view: 'timeline' },
  { atSec: 180, label: 'switch to board', view: 'board' },
  { atSec: 240, label: 'switch to plan tab (left rail)', view: null, leftTab: 'plan' },
  { atSec: 300, label: 'switch to roster tab (left rail)', view: null, leftTab: 'roster' },
];

for (const step of interactions) {
  if (Date.now() - startedAt > watchMs) break;
  const wait = step.atSec * 1000 - (Date.now() - startedAt);
  if (wait > 0) await page.waitForTimeout(wait);
  console.log(`  +${step.atSec}s — ${step.label}`);
  if (step.view) {
    await switchView(step.view);
  } else if (step.leftTab) {
    // Left-rail tabs ("PLAN", "ROSTER", "BOARD", "HEAT") use the same
    // selector pattern but with uppercase text.
    const tab = page.locator(
      `button:text-matches("^${step.leftTab.toUpperCase()}$", "i")`,
    ).first();
    await tab.click({ force: true, timeout: 3000 }).catch((e) => {
      console.log(`    ⚠ left-tab "${step.leftTab}" click failed: ${e.message?.slice(0, 80)}`);
    });
    await page.waitForTimeout(800);
  }
}

const remaining = watchMs - (Date.now() - startedAt);
if (remaining > 0) {
  console.log(`  waiting remaining ${Math.round(remaining / 1000)}s...`);
  await page.waitForTimeout(remaining);
}

console.log('closing browser to flush video...');
await page.close();
await ctx.close();
await browser.close();

writeFileSync(join(RECORD_DIR, 'console.log'), consoleLines.join('\n'));
const files = readdirSync(RECORD_DIR);
const webm = files.find((f) => f.endsWith('.webm'));
console.log(`video: ${webm ? join(RECORD_DIR, webm) : '(no webm found)'}`);
console.log(`console: ${join(RECORD_DIR, 'console.log')}`);
console.log(`run-id:  ${RUN_ID}`);
console.log();
console.log('next: extract frames with');
console.log(`  ffmpeg -i ${join(RECORD_DIR, webm)} -vf "fps=1/5" /tmp/swarm-recording/frames/frame-%03d.png`);
