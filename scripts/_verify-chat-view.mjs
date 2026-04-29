#!/usr/bin/env node
// Probe the new ChatView (rewritten 2026-04-28). Asserts the four
// behaviors that the rewrite was supposed to fix:
//
//   1. step-start / step-finish parts are NOT rendered as bubbles
//   2. user prompt fans across council sessions de-dup to one card
//   3. tool calls fold inline as pills inside the assistant turn card
//      (not standalone rows)
//   4. each turn card has a per-agent accent stripe + label
//
// Canonical run: run_moi14fqx_n73fln (council, 3 sessions). Same one
// the pattern-view audit uses, so behavior here mirrors the matrix.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const port = Number(readFileSync('.dev-port', 'utf8').trim());
const BASE = `http://127.0.0.1:${port}`;
const RUN_ID = 'run_moi14fqx_n73fln';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

console.log(`opening chat view at ${BASE}/?swarmRun=${RUN_ID}&view=chat`);
await page.goto(`${BASE}/?swarmRun=${RUN_ID}&view=chat`, {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});

// Wait for the chat content to settle — agent labels appear once
// the first turn lands. Council-3-session runs typically need 6-8s.
await page.waitForFunction(
  () => {
    const stripes = Array.from(document.querySelectorAll('div'))
      .filter((d) => typeof d.className === 'string' && d.className.includes('w-[3px]'));
    return stripes.length >= 3;
  },
  null,
  { timeout: 25_000 },
).catch(() => {});
await page.waitForTimeout(2000);

const probe = await page.evaluate(() => {
  const text = document.body.innerText;
  const stepStartRows = (text.match(/\bstep start\b/gi) || []).length;
  const stepFinishRows = (text.match(/\bstep finish\b/gi) || []).length;

  // For dedup, we need the truthful invariant: in this 3-session
  // council run the user fans the SAME prompt to 3 sessions. With
  // dedup that becomes 1 card. Count distinct user-prompt body
  // texts vs total "you" cards; if they're equal, dedup worked
  // (multi-round council can have multiple distinct user prompts —
  // each becomes its own deduped card).
  const youSpans = Array.from(document.querySelectorAll('span'))
    .filter((s) => (s.textContent || '').trim() === 'you');
  const youCount = youSpans.length;
  // Each "you" span is the agent label inside a UserTurnCard. Walk
  // up to the card root and capture the body text from a sibling.
  const youBodies = youSpans.map((s) => {
    // The label is in a header row; the card root is two ancestors up.
    const card = s.closest('div.flex.gap-3');
    return ((card?.textContent || '').trim()).slice(0, 200);
  });
  const distinctYouBodies = new Set(youBodies).size;

  // Tool pills — small h-5 buttons with the accent dot + tool name.
  const toolPills = Array.from(document.querySelectorAll('button'))
    .map((b) => (b.textContent || '').trim().toLowerCase())
    .filter((t) => /^(read|write|edit|bash|grep|glob|task|todowrite|webfetch|websearch|codesearch)(\s|$)/.test(t));

  // Stripes: detect by class first (more reliable than computed style
  // when bg-* tokens compile to var()). 3 sessions × N turns each ≈ many.
  const stripes = Array.from(document.querySelectorAll('div'))
    .filter((d) => typeof d.className === 'string' && d.className.includes('w-[3px]'))
    .length;

  return {
    stepStartRows,
    stepFinishRows,
    youCount,
    distinctYouBodies,
    toolPills: toolPills.length,
    sampleTools: toolPills.slice(0, 6),
    stripes,
  };
});

console.log('\n--- ChatView probe ---');
console.log(`  step-start labels:        ${probe.stepStartRows}  (target: 0)`);
console.log(`  step-finish labels:       ${probe.stepFinishRows}  (target: 0)`);
console.log(`  "you" cards / distinct:   ${probe.youCount} / ${probe.distinctYouBodies}  (target: equal — dedup collapses fan-out)`);
console.log(`  tool pills:               ${probe.toolPills}  (target: ≥3 for 3-session council)`);
console.log(`  sample tools seen:        ${probe.sampleTools.join(', ') || '(none)'}`);
console.log(`  3px accent stripes:       ${probe.stripes}  (target: ≥3 — one per turn card)`);

await browser.close();

const failures = [];
if (probe.stepStartRows > 0) failures.push(`step-start label still present (${probe.stepStartRows}× — should be filtered)`);
if (probe.stepFinishRows > 0) failures.push(`step-finish label still present (${probe.stepFinishRows}× — should be filtered)`);
if (probe.youCount === 0) failures.push('no user prompt cards rendered (expected ≥1)');
if (probe.youCount !== probe.distinctYouBodies) {
  failures.push(`dedup failed: ${probe.youCount} cards but only ${probe.distinctYouBodies} distinct bodies (council fan-out should collapse)`);
}
if (probe.toolPills < 3) failures.push(`only ${probe.toolPills} tool pills (expected ≥3 — every council session calls glob+read at minimum)`);
if (probe.stripes < 3) failures.push(`only ${probe.stripes} stripes (expected ≥3 — per-turn stripe)`);

if (failures.length > 0) {
  console.log('\nFAIL:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('\nOK — ChatView rewrite is rendering as designed');
