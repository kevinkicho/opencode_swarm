#!/usr/bin/env node
// Run-view audit — loads /?swarmRun=<id> in Playwright, checks that
// the page renders the expected pattern-specific surfaces for the
// run's pattern without console errors. Complements _ui_audit.mjs
// (which tests mock + modal flows); this one tests the live-run path.
//
// Usage:
//   node scripts/_run_view_audit.mjs <swarmRunID> [--origin URL]

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const runID = args.find((a) => !a.startsWith('--'));
const ORIGIN = args.includes('--origin')
  ? args[args.indexOf('--origin') + 1]
  : 'http://localhost:49187';
if (!runID) {
  console.error('usage: node scripts/_run_view_audit.mjs <swarmRunID> [--origin URL]');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`run-view audit — ${ORIGIN}/?swarmRun=${runID}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Fetch meta up front so we know what to expect.
  const metaResp = await fetch(`${ORIGIN}/api/swarm/run/${runID}`);
  if (!metaResp.ok) {
    console.error(`meta fetch failed: HTTP ${metaResp.status}`);
    await browser.close();
    process.exit(1);
  }
  const metaPayload = await metaResp.json();
  const meta = metaPayload.meta ?? metaPayload;
  console.log(`  pattern: ${meta.pattern}`);
  console.log(`  sessions: ${meta.sessionIDs?.length ?? 0}\n`);

  console.log('page load');
  try {
    await page.goto(`${ORIGIN}/?swarmRun=${runID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    // networkidle can't fire when SSE streams stay open, so don't wait
    // on it. Instead wait explicitly for the meta fetch to resolve the
    // board tab rendering — 7s empirically covers the hydration +
    // meta-fetch chain. A faster wait (1-2s) races the `boardSwarmRunID`
    // memo that gates pattern-specific tab buttons; a false negative
    // from that race bit the 2026-04-23 audit and wasted 20 min.
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => undefined);
    await page.waitForTimeout(7_000);
    check('page loads without navigation crash', true);
  } catch (err) {
    check('page loads without navigation crash', false, err.message.slice(0, 100));
    await browser.close();
    summarize();
    return;
  }

  check(
    'no fatal pageerrors',
    pageErrors.length === 0,
    pageErrors.length === 0 ? '' : pageErrors.slice(0, 2).join(' | '),
  );

  // Topbar doesn't render the raw run id — only derived signals
  // (pattern badge, directive teaser, status dot). Check that some
  // topbar region exists rather than matching a specific string.
  const topbarRegion = await page
    .locator('button:has-text("new run")')
    .first()
    .isVisible()
    .catch(() => false);
  check('topbar region mounted', topbarRegion);

  // Pattern-specific surface expectations.
  console.log('\npattern-specific surfaces');
  if (meta.pattern === 'critic-loop') {
    // No verdict yet (opencode frozen), so strip should NOT be rendered.
    // Confirm the strip returns null gracefully instead of crashing.
    const strip = await page
      .locator('text=/critic · /i')
      .first()
      .isVisible()
      .catch(() => false);
    check('CriticVerdictStrip: absent pre-verdict (expected)', !strip);
  } else if (meta.pattern === 'debate-judge') {
    const strip = await page
      .locator('text=/judge · /i')
      .first()
      .isVisible()
      .catch(() => false);
    check('JudgeVerdictStrip: absent pre-verdict (expected)', !strip);
  } else if (meta.pattern === 'orchestrator-worker') {
    // Strip is gated on "orchestrator has produced ≥1 completed text turn"
    // which won't fire without opencode. Absence is expected.
    const strip = await page
      .locator('text=orchestrator')
      .first()
      .isVisible()
      .catch(() => false);
    check(
      'OrchestratorActionsStrip: absent pre-first-turn (expected)',
      !strip,
    );
  } else if (meta.pattern === 'deliberate-execute') {
    // Board view accessible? (patterns with board-execution get the board tab)
    const boardTab = await page
      .locator('button:has-text("board")')
      .first()
      .isVisible()
      .catch(() => false);
    check('board tab visible for deliberate-execute', boardTab);
  }

  // Take a screenshot for visual evidence.
  const screenshotPath = `/tmp/run-view-${meta.pattern}.png`;
  await page.screenshot({ path: screenshotPath }).catch(() => undefined);
  console.log(`\nscreenshot: ${screenshotPath}`);

  check(
    'no console errors during render',
    consoleErrors.length === 0,
    consoleErrors.length === 0
      ? ''
      : `${consoleErrors.length}: ${consoleErrors.slice(0, 1).join(' | ').slice(0, 160)}`,
  );

  await browser.close();
  summarize();
}

function summarize() {
  console.log('\n── summary ──');
  const passed = results.filter((r) => r.ok).length;
  console.log(`  ${passed}/${results.length} checks passed`);
  const fails = results.filter((r) => !r.ok);
  if (fails.length > 0) {
    for (const f of fails) {
      console.log(`    ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('run-view audit crashed:', err);
  process.exit(1);
});
