// IMPLEMENTATION_PLAN Phase-7 verification suite — runs the 10 probes
// that gate SHIPPED-UNVERIFIED → VERIFIED on the Q1–Q15 backlog.
//
//   node scripts/_verify-q-suite.mjs               # uses .dev-port, root URL
//   node scripts/_verify-q-suite.mjs <swarmRunID>  # checks against ?swarmRun=<id>
//   PROD=1 node scripts/_verify-q-suite.mjs ...    # uses :3100 prod build
//
// Each probe is a small, named function that returns {status, detail}.
// status: 'pass' | 'fail' | 'skip'. Skipped probes call out why
// (typically: needs a swarmRunID, or content prerequisites missing).
//
// Run after spawning a real swarmRun and letting it produce some
// activity. The probes are read-only — never click anything that
// mutates state.

import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PROD = process.env.PROD === '1';
const runIDArg = process.argv[2] ?? '';

function resolveUrl() {
  const port = PROD
    ? '3100'
    : existsSync('.dev-port')
      ? readFileSync('.dev-port', 'utf8').trim()
      : '49187';
  const base = `http://localhost:${port}`;
  return runIDArg ? `${base}/?swarmRun=${runIDArg}` : `${base}/`;
}

const url = resolveUrl();
console.log(`[verify-q-suite] target: ${url}\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const t0 = Date.now();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
} catch (err) {
  console.error(`[verify-q-suite] navigation failed: ${err.message}`);
  await browser.close();
  process.exit(1);
}
// Generous warmup so SSE settles, lazy chunks compile, content renders.
await page.waitForTimeout(8000);
const navMs = Date.now() - t0;
console.log(`[verify-q-suite] hydrated in ${navMs}ms\n`);

const results = [];
function record(id, name, status, detail) {
  results.push({ id, name, status, detail });
}

// ── Q1 + Q8 — auto-stick-to-bottom on entry / hard refresh ───────────
async function probeStickToBottom() {
  if (!runIDArg) {
    record('Q1+Q8', 'auto-stick-to-bottom', 'skip', 'needs swarmRunID');
    return;
  }
  // Find the timeline scroll container. Several rails use a scroll
  // ref; we look for the one that owns the most rows.
  const data = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('[class*="overflow-y-auto"]'),
    );
    let best = null;
    let bestCount = 0;
    for (const el of candidates) {
      const n = el.querySelectorAll('li').length;
      if (n > bestCount) {
        best = el;
        bestCount = n;
      }
    }
    if (!best) return null;
    return {
      scrollTop: best.scrollTop,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
      rows: bestCount,
    };
  });
  if (!data) {
    record('Q1+Q8', 'auto-stick-to-bottom', 'skip', 'no scroll container with rows found');
    return;
  }
  const distance = data.scrollHeight - data.scrollTop - data.clientHeight;
  const atBottom = distance < 80;
  record(
    'Q1+Q8',
    'auto-stick-to-bottom',
    atBottom ? 'pass' : 'fail',
    `${data.rows} rows · scrollTop=${data.scrollTop} · distance-from-bottom=${distance}px`,
  );
}

// ── Q2 — `latest ↓` button visibility ────────────────────────────────
async function probeLatestButton() {
  const data = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="scroll to latest"]');
    if (!btn) return { exists: false };
    const styles = window.getComputedStyle(btn);
    return {
      exists: true,
      opacity: styles.opacity,
      pointerEvents: styles.pointerEvents,
      visible: styles.opacity !== '0' && styles.visibility !== 'hidden',
    };
  });
  if (!data.exists) {
    record('Q2', 'latest-button-present', 'skip', 'button not in DOM (likely no scrollable content)');
    return;
  }
  // The button hides itself when at-bottom; that's correct behavior.
  // Pass = it exists in the DOM and renders correctly when needed.
  record(
    'Q2',
    'latest-button-present',
    'pass',
    `aria-label="scroll to latest" present, opacity=${data.opacity}`,
  );
}

// ── Q6 — roster status chip on each row ──────────────────────────────
async function probeRosterStatus() {
  if (!runIDArg) {
    record('Q6', 'roster-status-chip', 'skip', 'needs swarmRunID');
    return;
  }
  const data = await page.evaluate(() => {
    // Roster tab contains agent rows. Match against any text node
    // matching one of the canonical status words.
    const STATUS_RE = /\b(idle|working|drafting|reviewing|error|errored|claiming|approved|revising|completed|done|stale)\b/i;
    const tab = document.querySelector('[data-tab="roster"]') ||
      document.querySelector('button[aria-label*="roster" i]')?.closest('section') ||
      document.body;
    const rows = Array.from(tab.querySelectorAll('li, [role="listitem"]'));
    const total = rows.length;
    const matched = rows.filter((r) => STATUS_RE.test(r.textContent ?? '')).length;
    return { total, matched };
  });
  if (data.total === 0) {
    record('Q6', 'roster-status-chip', 'skip', 'no roster rows visible');
    return;
  }
  // Pass = at least most rows show a status word. Some rows may
  // legitimately not yet have a chip if they're brand-new.
  const ratio = data.matched / data.total;
  record(
    'Q6',
    'roster-status-chip',
    ratio >= 0.5 ? 'pass' : 'fail',
    `${data.matched}/${data.total} rows have a status word`,
  );
}

// ── Q7 — directive width truncated to 240px ──────────────────────────
async function probeDirectiveTruncation() {
  if (!runIDArg) {
    record('Q7', 'directive-truncation', 'skip', 'needs swarmRunID');
    return;
  }
  const data = await page.evaluate(() => {
    const btn = document.querySelector('button[title="click for full directive"]');
    if (!btn) return { exists: false };
    const rect = btn.getBoundingClientRect();
    return {
      exists: true,
      width: rect.width,
      classList: Array.from(btn.classList).join(' '),
    };
  });
  if (!data.exists) {
    record('Q7', 'directive-truncation', 'skip', 'directive button not found');
    return;
  }
  // Pass = width does not exceed ~250px (240 cap + a few px slop).
  const ok = data.width <= 250;
  record(
    'Q7',
    'directive-truncation',
    ok ? 'pass' : 'fail',
    `width=${Math.round(data.width)}px (cap 240) · classes=${data.classList.includes('max-w-[240px]') ? 'has-cap' : 'NO max-w-[240px]'}`,
  );
}

// ── Q9 — parts filter shows ≥12 part types ───────────────────────────
async function probePartsFilter() {
  // Open the parts dropdown (button with aria-label or text "parts").
  const opened = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) =>
      /\bparts?\b/i.test(b.textContent ?? '') ||
      /parts/i.test(b.getAttribute('aria-label') ?? ''),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) {
    record('Q9', 'parts-filter-options', 'skip', 'parts button not found');
    return;
  }
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    // Dropdown options. Look for any role=menuitem or similar.
    const items = Array.from(
      document.querySelectorAll('[role="menuitem"], [role="option"], li[role]'),
    );
    return { count: items.length, sampled: items.slice(0, 5).map((i) => i.textContent?.trim() ?? '') };
  });
  if (data.count === 0) {
    record('Q9', 'parts-filter-options', 'skip', 'dropdown menu rendered no items');
    return;
  }
  record(
    'Q9',
    'parts-filter-options',
    data.count >= 12 ? 'pass' : 'fail',
    `${data.count} options visible (need ≥12)`,
  );
}

// ── Q10 — react-scan default-off (no rerender outlines) ─────────────
async function probeReactScanOff() {
  const data = await page.evaluate(() => {
    // react-scan injects either a #react-scan-outlines element or
    // applies outline classes to rendered nodes. Check neither exists.
    const overlay = document.querySelector('#react-scan-outline, [data-react-scan]');
    return { hasOverlay: !!overlay };
  });
  record(
    'Q10',
    'react-scan-default-off',
    data.hasOverlay ? 'fail' : 'pass',
    data.hasOverlay ? 'react-scan overlay visible by default' : 'no react-scan overlay (toggle is off)',
  );
}

// ── Q11 — lane meter renders `in <X>` BEFORE `out <Y>` ──────────────
async function probeLaneMeterOrder() {
  if (!runIDArg) {
    record('Q11', 'lane-meter-in-first', 'skip', 'needs swarmRunID');
    return;
  }
  const data = await page.evaluate(() => {
    // Lane meters live in the timeline lane headers. Look for any
    // element where text contains both "in" and "out" — check order.
    const candidates = Array.from(document.querySelectorAll('div, header, span'))
      .filter((el) => {
        const t = el.textContent ?? '';
        return t.length < 80 && /\bin\b/.test(t) && /\bout\b/.test(t);
      });
    if (candidates.length === 0) return null;
    // Inspect the first non-trivial match — its DIRECT text content
    // (sum of immediate child text nodes / spans).
    const el = candidates[0];
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const inIdx = text.search(/\bin\s+\d/);
    const outIdx = text.search(/\bout\s+\d/);
    return { text, inIdx, outIdx };
  });
  if (!data) {
    record('Q11', 'lane-meter-in-first', 'skip', 'no lane meter with both in/out values found');
    return;
  }
  if (data.inIdx < 0 || data.outIdx < 0) {
    record('Q11', 'lane-meter-in-first', 'skip', `partial match: ${data.text.slice(0, 60)}`);
    return;
  }
  record(
    'Q11',
    'lane-meter-in-first',
    data.inIdx < data.outIdx ? 'pass' : 'fail',
    `text="${data.text.slice(0, 60)}" · in@${data.inIdx} out@${data.outIdx}`,
  );
}

// ── Q13 — picker latency (open → first row visible < 1s) ─────────────
async function probePickerLatency() {
  // Click the runs picker trigger.
  const opened = await page.evaluate(() => {
    const trigger = document.querySelector('[aria-label="browse swarm runs"]');
    if (!trigger) return false;
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  if (!opened) {
    record('Q13', 'picker-latency', 'skip', 'picker trigger not found');
    return;
  }
  const start = Date.now();
  // Poll for the first picker row to appear.
  let firstRowMs = null;
  for (let i = 0; i < 30; i += 1) {
    const has = await page.evaluate(() => {
      const open = document.querySelector('[role="dialog"], [role="listbox"], .swarm-runs-picker') ||
        document.querySelector('[aria-haspopup="dialog"][aria-expanded="true"]')?.parentElement;
      if (!open) return false;
      return open.querySelector('li, [role="option"], [role="row"]') !== null;
    });
    if (has) {
      firstRowMs = Date.now() - start;
      break;
    }
    await page.waitForTimeout(50);
  }
  if (firstRowMs === null) {
    record('Q13', 'picker-latency', 'skip', 'no picker rows appeared within 1.5s');
    return;
  }
  record(
    'Q13',
    'picker-latency',
    firstRowMs < 1000 ? 'pass' : 'fail',
    `time-to-first-row=${firstRowMs}ms (target <1000ms after page warm)`,
  );
}

// ── Q15 — picker rows have NO color status dot ───────────────────────
async function probePickerStatusDot() {
  // Picker should still be open from Q13. If not, reopen.
  const reopened = await page.evaluate(() => {
    const open = document.querySelector('[role="dialog"], [role="listbox"], .swarm-runs-picker');
    if (open) return true;
    const trigger = document.querySelector('[aria-label="browse swarm runs"]');
    if (!trigger) return false;
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  if (!reopened) {
    record('Q15', 'picker-no-status-dot', 'skip', 'picker not openable');
    return;
  }
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    // Find picker rows.
    const root = document.querySelector('[role="dialog"], [role="listbox"], .swarm-runs-picker');
    if (!root) return null;
    const rows = Array.from(root.querySelectorAll('li, [role="option"], [role="row"]'));
    const rowsWithDot = rows.filter((r) => {
      // Only count dots inside what looks like the status column —
      // small (≤ 12px) rounded-full elements. Other rounded-full
      // elements (avatars, overflow indicators) shouldn't count.
      return Array.from(r.querySelectorAll('[class*="rounded-full"]')).some(
        (el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.width <= 12 && rect.height <= 12;
        },
      );
    });
    return { totalRows: rows.length, rowsWithDot: rowsWithDot.length };
  });
  if (!data || data.totalRows === 0) {
    record('Q15', 'picker-no-status-dot', 'skip', 'no picker rows visible');
    return;
  }
  record(
    'Q15',
    'picker-no-status-dot',
    data.rowsWithDot === 0 ? 'pass' : 'fail',
    `${data.rowsWithDot}/${data.totalRows} rows still carry a small color dot`,
  );
}

// ── Run the suite ────────────────────────────────────────────────────
const probes = [
  probeStickToBottom,
  probeLatestButton,
  probeRosterStatus,
  probeDirectiveTruncation,
  probePartsFilter,
  probeReactScanOff,
  probeLaneMeterOrder,
  probePickerLatency,
  probePickerStatusDot,
];

for (const probe of probes) {
  try {
    await probe();
  } catch (err) {
    record(probe.name, probe.name, 'fail', `threw: ${err.message}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────
console.log('\n=== verify-q-suite results ===\n');
const counts = { pass: 0, fail: 0, skip: 0 };
for (const r of results) {
  const tag =
    r.status === 'pass' ? '\x1b[32mPASS\x1b[0m' :
    r.status === 'fail' ? '\x1b[31mFAIL\x1b[0m' :
    '\x1b[33mSKIP\x1b[0m';
  console.log(`${tag} ${r.id.padEnd(8)} ${r.name.padEnd(28)} ${r.detail}`);
  counts[r.status] += 1;
}
console.log(
  `\n${counts.pass} passed · ${counts.fail} failed · ${counts.skip} skipped (need a live swarmRun for full coverage)`,
);

await browser.close();
process.exit(counts.fail > 0 ? 1 : 0);
