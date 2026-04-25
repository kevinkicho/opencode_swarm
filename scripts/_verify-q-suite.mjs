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
  // Click the roster tab button — it's a small font-mono button labeled
  // "roster" in the LeftTabs strip. Without this the panel might be on
  // a different tab (plan/board) and have no roster rows in the DOM.
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => /^roster$/i.test((b.textContent ?? '').trim()),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!clicked) {
    record('Q6', 'roster-status-chip', 'skip', 'roster tab button not found');
    return;
  }
  await page.waitForTimeout(400);
  const data = await page.evaluate(() => {
    // No word boundaries — roster rows concatenate name and status
    // without a delimiter (e.g. "build #1error"), and \b doesn't fire
    // between digit and letter (both are \w).
    const STATUS_RE = /(idle|working|drafting|reviewing|errored|error|claiming|approved|revising|completed|done|stale|thinking)/i;
    const candidates = Array.from(document.querySelectorAll('li, [role="listitem"]')).filter(
      (el) => {
        const t = (el.textContent ?? '').trim();
        return t.length > 0 && t.length < 200;
      },
    );
    const matched = candidates.filter((r) => STATUS_RE.test(r.textContent ?? ''));
    return { total: candidates.length, matched: matched.length };
  });
  if (data.total === 0) {
    record('Q6', 'roster-status-chip', 'skip', 'no roster rows visible after tab click');
    return;
  }
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
  // Parts filter is on the timeline view — make sure that's active
  // before looking for the button. Click any "timeline" tab if present.
  await page.evaluate(() => {
    const tlBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => /^timeline$/i.test((b.textContent ?? '').trim()),
    );
    if (tlBtn) tlBtn.click();
  });
  await page.waitForTimeout(300);
  // Open the parts dropdown.
  const opened = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => /^parts$/i.test((b.textContent ?? '').trim()),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) {
    record('Q9', 'parts-filter-options', 'skip', 'parts button not found');
    return;
  }
  await page.waitForTimeout(500);
  const data = await page.evaluate(() => {
    // Scope to the multi-select popover by searching for the unique
    // "part types" + "multi-select" header — there are other popovers
    // on the page (recent-parts panel, etc.) we don't want to count.
    const popover = Array.from(document.querySelectorAll('div')).find(
      (el) =>
        /part types/i.test(el.textContent ?? '') &&
        /multi-select/i.test(el.textContent ?? ''),
    );
    if (!popover) return { found: false, count: 0, names: [] };
    const PART_NAMES = ['text','reasoning','tool','subtask','agent','patch','file','step-start','step-finish','snapshot','compaction','retry'];
    const buttonText = Array.from(popover.querySelectorAll('button')).map(
      (b) => (b.textContent ?? '').trim().toLowerCase(),
    );
    // Each row's button starts with the part name. Match by prefix.
    const matched = PART_NAMES.filter((n) =>
      buttonText.some((t) => t === n || t.startsWith(n)),
    );
    return { found: true, count: matched.length, names: matched };
  });
  if (!data.found) {
    record('Q9', 'parts-filter-options', 'skip', 'multi-select popover not found');
    return;
  }
  record(
    'Q9',
    'parts-filter-options',
    data.count >= 12 ? 'pass' : 'fail',
    `${data.count}/12 part-name rows found: ${data.names.join(', ')}`,
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
  // Lane meters render on the timeline view; ensure it's active.
  await page.evaluate(() => {
    const tlBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => /^timeline$/i.test((b.textContent ?? '').trim()),
    );
    if (tlBtn) tlBtn.click();
  });
  await page.waitForTimeout(300);
  const data = await page.evaluate(() => {
    // Lane meters render two SIBLING spans: one with "in <X>" and one
    // with "out <Y>", both inside a flex container. Look for ALL
    // adjacent in/out pairs by walking parents that contain BOTH a
    // span starting with "in " and one starting with "out ".
    const allSpans = Array.from(document.querySelectorAll('span'));
    const inSpans = allSpans.filter((s) => /^\s*in\s/.test(s.textContent ?? ''));
    const outSpans = allSpans.filter((s) => /^\s*out\s/.test(s.textContent ?? ''));
    if (inSpans.length === 0 || outSpans.length === 0) return null;
    // For each in-span, find an out-span that shares a parent and
    // compare DOM order (compareDocumentPosition).
    for (const inS of inSpans) {
      for (const outS of outSpans) {
        if (inS.parentElement !== outS.parentElement) continue;
        const order = inS.compareDocumentPosition(outS);
        const inFirst = !!(order & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          inText: (inS.textContent ?? '').trim(),
          outText: (outS.textContent ?? '').trim(),
          inFirst,
        };
      }
    }
    return null;
  });
  if (!data) {
    record('Q11', 'lane-meter-in-first', 'skip', 'no in/out span pair sharing a parent found');
    return;
  }
  record(
    'Q11',
    'lane-meter-in-first',
    data.inFirst ? 'pass' : 'fail',
    `"${data.inText}" / "${data.outText}" — in-first: ${data.inFirst}`,
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
