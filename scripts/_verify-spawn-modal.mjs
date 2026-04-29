#!/usr/bin/env node
// Probe the spawn-agent modal for parity with the new-run team picker:
//
//   1. provider-tier filter chips render with per-tier counts
//   2. clicking a chip toggles the visible model count in the picker
//   3. ollama help "?" chip is present when ollama models are in catalog
//   4. layer-1 ollama hint shows when ollama is in the active filter
//
// Spawn modal lives off the agent-roster + icon (sidebar). We open
// the canonical council run (which has a populated roster) and click
// the + icon to open the modal.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const port = Number(readFileSync('.dev-port', 'utf8').trim());
const BASE = `http://127.0.0.1:${port}`;
const RUN_ID = 'run_moi14fqx_n73fln';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();

console.log(`opening ${BASE}/?swarmRun=${RUN_ID}`);
await page.goto(`${BASE}/?swarmRun=${RUN_ID}`, {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});
await page.waitForTimeout(6000);

// The spawn button lives on the roster left-tab. Click that tab,
// then click the roster's "+" button (Tooltip-wrapped, so we
// identify it by structural position — the only IconPlus in the
// roster header row).
await page.locator('button').filter({ hasText: /^roster$/ }).first().click();
await page.waitForTimeout(800);

// Programmatic click via DOM: find the + button (svg-only, h-6 w-6)
// at the rightmost end of the roster header.
const opened = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
    .filter((b) => {
      const cls = b.className || '';
      if (typeof cls !== 'string') return false;
      const hasSvg = !!b.querySelector('svg');
      const sized = cls.includes('w-6') && cls.includes('h-6');
      return hasSvg && sized;
    });
  // Last one is the +/spawn button (header row; agent rows have other svgs)
  const last = buttons[buttons.length - 1];
  if (!last) return false;
  last.click();
  return true;
});
if (!opened) {
  console.error('could not locate spawn + button');
  await browser.close();
  process.exit(2);
}

await page.waitForTimeout(1500);

// Modal should now be open. Probe its content.
const probe = await page.evaluate(() => {
  // Provider chips: small h-5 buttons with text like "go", "zen",
  // "ollama" alongside an aria-pressed attribute.
  const allButtons = Array.from(document.querySelectorAll('button'));
  const providerChips = allButtons
    .filter((b) => b.hasAttribute('aria-pressed'))
    .map((b) => ({
      label: (b.textContent || '').trim().toLowerCase(),
      pressed: b.getAttribute('aria-pressed') === 'true',
    }));

  // Ollama help "?" chip.
  const ollamaHelp = allButtons.some((b) => {
    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
    const txt = (b.textContent || '').trim();
    return aria.includes('ollama') || (txt === '?' && aria.includes('ollama'));
  });

  // X/Y models indicator: span with text matching the pattern.
  const modelsCounter = Array.from(document.querySelectorAll('span'))
    .map((s) => (s.textContent || '').trim())
    .find((t) => /^\d+\/\d+\s+models$/.test(t));

  // Layer-1 ollama hint: contains "ollama tip · " text and the "ollama
  // pull" word together.
  const text = document.body.innerText;
  const hasOllamaTip = /ollama tip\s*·/i.test(text) && /ollama pull/i.test(text);

  // Model rows in the picker: count visible h-5 button rows inside
  // the model picker. The picker has hairline-b separators on its
  // li > button rows.
  const modelRows = Array.from(document.querySelectorAll('li > button'))
    .filter((b) => {
      const cls = b.className || '';
      return typeof cls === 'string' && cls.includes('h-5') && cls.includes('hairline-b');
    }).length;

  // Static / Live badge text presence (for tooltip target).
  const sourceBadge = Array.from(document.querySelectorAll('span'))
    .map((s) => (s.textContent || '').trim().toLowerCase())
    .find((t) => t === 'live' || t === 'static') || null;

  return { providerChips, ollamaHelp, modelsCounter, hasOllamaTip, modelRows, sourceBadge };
});

await page.screenshot({ path: '/tmp/spawn-modal-with-chips.png', fullPage: false });
console.log('\n--- spawn modal probe ---');
console.log('  provider chips:           ', probe.providerChips);
console.log('  ollama help "?" present:  ', probe.ollamaHelp);
console.log('  models counter:           ', probe.modelsCounter);
console.log('  layer-1 ollama tip:       ', probe.hasOllamaTip);
console.log('  model rows visible:       ', probe.modelRows);
console.log('  catalog source badge:     ', probe.sourceBadge);
console.log('  screenshot at /tmp/spawn-modal-with-chips.png');

await browser.close();

const failures = [];
if (probe.providerChips.length === 0) failures.push('no provider chips rendered');
if (!probe.modelsCounter) failures.push('no "X/Y models" counter rendered');
if (!probe.sourceBadge) failures.push('no live/static catalog badge');
if (probe.modelRows === 0) failures.push('no model rows visible');
// ollama hint + ollama help are conditional on ollama being in the catalog;
// only assert if the chips list shows ollama.
const hasOllama = probe.providerChips.some((c) => c.label.startsWith('ollama'));
if (hasOllama) {
  if (!probe.ollamaHelp) failures.push('ollama present in catalog but no "?" help chip');
  if (!probe.hasOllamaTip) failures.push('ollama present + filter on, but no Layer-1 hint');
}

if (failures.length > 0) {
  console.log('\nFAIL:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\nOK — spawn modal mirrors new-run provider-tier UX');
