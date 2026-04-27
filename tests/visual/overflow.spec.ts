// Structural overflow probe — runs across every chromium-* viewport
// project (desktop, narrow, mobile) and asserts no rendered element is
// wider than the viewport.
//
// Catches the regression class behind the 2026-04-27 timeline overflow
// (a hard-coded 800px floor that overflowed at 768px). Single-viewport
// visual baselines couldn't see this — they only diff what actually
// rendered. This probe runs the same routes at multiple breakpoints
// and fails loud the moment any element exceeds clientWidth.
//
// Run via: `npx playwright test tests/visual/overflow.spec.ts`
//
// Note: scroll containers (e.g. the timeline canvas itself) legitimately
// host wide content that scrolls horizontally. We allow up to a 20px
// slack so subpixel layout drift doesn't false-positive, but anything
// wider than viewport+20 is treated as a real overflow.

import { test, expect } from '@playwright/test';

const RICH_RUN = 'run_mogmbj1l_68ah11';

const ROUTES_TO_AUDIT: { label: string; url: string }[] = [
  { label: 'home', url: '/' },
  { label: 'home-rich-run', url: `/?swarmRun=${RICH_RUN}` },
  { label: 'metrics', url: '/metrics' },
  { label: 'projects', url: '/projects' },
  { label: 'retro', url: `/retro/${RICH_RUN}` },
];

// Some elements legitimately scroll horizontally (the timeline canvas
// for many-lane runs is the canonical case). Their parents must have
// overflow:auto/scroll/hidden so the page itself doesn't smear. This
// helper walks ancestors looking for a containing scroller — if one
// exists, the wide element is fine.
const PROBE_SCRIPT = `
(() => {
  const slack = 20; // px tolerance for subpixel anti-alias drift
  const vw = document.documentElement.clientWidth;
  const limit = vw + slack;
  const offenders = [];
  const all = document.querySelectorAll('body, body *');
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= limit) continue;
    // Walk up looking for a scroll container. If found, this element's
    // overflow is contained — not a page-level bug.
    let parent = el.parentElement;
    let contained = false;
    while (parent) {
      const cs = window.getComputedStyle(parent);
      if (
        cs.overflowX === 'auto' ||
        cs.overflowX === 'scroll' ||
        cs.overflowX === 'hidden'
      ) {
        contained = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (contained) continue;
    const cls =
      typeof el.className === 'string'
        ? el.className
        : (el.className && el.className.baseVal) || '';
    offenders.push({
      tag: el.tagName.toLowerCase(),
      cls: cls.slice(0, 60),
      width: Math.round(rect.width),
      vw,
    });
  }
  return offenders;
})();
`;

for (const route of ROUTES_TO_AUDIT) {
  test(`${route.label} fits its viewport (no uncontained overflow)`, async ({ page }) => {
    await page.goto(route.url, { waitUntil: 'domcontentloaded' });
    // Settle: hydration + initial /api/swarm/run poll. Longer for
    // rich-run because the timeline does its own layout pass.
    await page.waitForTimeout(route.label === 'home-rich-run' ? 3500 : 2200);
    const offenders = await page.evaluate(PROBE_SCRIPT);
    expect(
      offenders,
      // Helpful failure context: dump every offender with its width
      // so the failure message points at exactly what overflowed.
      `Found uncontained wide elements at viewport ${page.viewportSize()?.width}px:\n${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
}
