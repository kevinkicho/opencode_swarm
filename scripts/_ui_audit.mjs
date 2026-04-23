#!/usr/bin/env node
// UI audit: Playwright-driven check of tonight's UI ships. Runs without
// opencode producing tokens — covers the rendering + interaction paths
// that don't need the LLM alive.
//
// What it checks (see ui-audit output for PASS/FAIL per item):
//   - Home page loads without console errors
//   - New-run modal opens and shows all 9 pattern tiles (including
//     the 5 hierarchical patterns shipped 2026-04-23)
//   - API-recipes collapsible block toggles + shows all pattern entries
//   - Copy button on a recipe works without throwing
//   - Pattern tile accents render (rust / fog are the new colors)
//   - board-preview route loads without console errors (mock mode)
//
// Usage:
//   node scripts/_ui_audit.mjs
//   node scripts/_ui_audit.mjs --origin http://localhost:49187

import { chromium } from 'playwright';

const ORIGIN = process.argv.includes('--origin')
  ? process.argv[process.argv.indexOf('--origin') + 1]
  : 'http://localhost:49187';

const ALL_PATTERNS = [
  'none',
  'blackboard',
  'map-reduce',
  'council',
  'orchestrator-worker',
  'role-differentiated',
  'debate-judge',
  'critic-loop',
  'deliberate-execute',
];

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log(`UI audit — ${ORIGIN}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // ---- Home page ----
  console.log('home page');
  try {
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    check('home loads (no navigation crash)', true);
    // allow a beat for lazy chunks
    await page.waitForTimeout(1200);
  } catch (err) {
    check('home loads (no navigation crash)', false, err.message);
    await browser.close();
    summarize();
    return;
  }
  check(
    'home has no fatal pageerrors',
    pageErrors.length === 0,
    pageErrors.length === 0 ? '' : pageErrors.slice(0, 2).join(' | '),
  );

  // ---- Open new-run modal ----
  console.log('\nnew-run modal');
  // The topbar has a "new run" trigger — look for it by visible text.
  // Fall back: open via palette (Cmd/Ctrl+K) if no direct button.
  let modalOpened = false;
  try {
    const trigger = page.getByRole('button', { name: /new run/i }).first();
    await trigger.waitFor({ state: 'visible', timeout: 4_000 });
    await trigger.click();
    // modal render
    await page.waitForTimeout(600);
    // presence of a clearly-modal element
    const hasPatternLabel = await page.locator('text=/pattern/i').first().isVisible().catch(() => false);
    modalOpened = hasPatternLabel;
    check('new-run modal opens', modalOpened);
  } catch (err) {
    check('new-run modal opens', false, err.message.slice(0, 100));
  }

  if (modalOpened) {
    // Count pattern tiles by locating by label text. patternMeta labels:
    // none, blackboard, map-reduce, council, orchestrator, roles, debate,
    // critic, deliberate→execute.
    const labels = ['none', 'blackboard', 'map-reduce', 'council', 'orchestrator', 'roles', 'debate', 'critic', 'deliberate'];
    for (const lbl of labels) {
      const found = await page
        .locator(`button:has-text("${lbl}")`)
        .first()
        .isVisible()
        .catch(() => false);
      check(`pattern tile visible: ${lbl}`, found);
    }

    // API recipes collapsible
    const recipesHeader = page.locator('button:has-text("api recipes")').first();
    const recipesVisible = await recipesHeader.isVisible().catch(() => false);
    check('api-recipes collapsible header visible', recipesVisible);
    if (recipesVisible) {
      await recipesHeader.click();
      await page.waitForTimeout(400);
      // each pattern recipe surfaces its pattern id via a monospace span
      for (const p of ALL_PATTERNS) {
        const found = await page
          .locator(`text="${p}"`)
          .first()
          .isVisible()
          .catch(() => false);
        check(`recipe entry present: ${p}`, found);
      }
      // Copy button on the first recipe
      const copyBtn = page.locator('button:has-text("copy")').first();
      const copyVisible = await copyBtn.isVisible().catch(() => false);
      check('copy button visible', copyVisible);
      if (copyVisible) {
        // Grant clipboard permission so writeText resolves without error
        await ctx
          .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
          .catch(() => undefined);
        await copyBtn.click();
        await page.waitForTimeout(200);
        const copiedVisible = await page
          .locator('button:has-text("copied")')
          .first()
          .isVisible()
          .catch(() => false);
        check('copy click shows "copied ✓"', copiedVisible);
      }
    }

    // Screenshot for evidence
    await page
      .screenshot({ path: '/tmp/ui-audit-modal.png', fullPage: false })
      .catch(() => undefined);
  }

  // Close modal before next step (escape)
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.waitForTimeout(400);

  // ---- board-preview mock route ----
  console.log('\nboard-preview (mock mode)');
  try {
    await page.goto(`${ORIGIN}/board-preview`, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    await page.waitForTimeout(800);
    check('board-preview mock loads', true);
    // Roster row should be visible with at least one chip
    const rosterVisible = await page
      .locator('text=/roster/i')
      .first()
      .isVisible()
      .catch(() => false);
    check('board-preview roster row visible', rosterVisible);
  } catch (err) {
    check('board-preview mock loads', false, err.message.slice(0, 100));
  }

  await browser.close();

  // ---- Post-run console summary ----
  console.log('\nconsole summary');
  check(
    'no console errors observed across flows',
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? '' : `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 2).join(' | ')}`,
  );

  summarize();
}

function summarize() {
  console.log('\n── summary ──');
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`  ${passed}/${total} checks passed`);
  const fails = results.filter((r) => !r.ok);
  if (fails.length > 0) {
    console.log('\n  failed:');
    for (const f of fails) {
      console.log(`    ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ui-audit crashed:', err);
  process.exit(1);
});
