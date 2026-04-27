// Production-build performance probe.
//
// What this catches: a real regression in production runtime perf —
// e.g. a new client-side dep that doubles the JS bundle, or a slow
// data-fetch that pushes LCP past the threshold.
//
// What this does NOT catch: dev-mode cold-compile time. That's
// Next.js dev behavior, not a bug we can test for. The user-reported
// 12s FCP from `npm run dev` is normal; production paint is sub-2s.
// (Use `npm run prod` for a fast local experience.)
//
// Thresholds are calibrated for a production Next.js 14 build on a
// reasonable dev machine. They're informational hard-fails: if the
// number breaks the threshold, something genuinely changed — bundle
// size, data-fetch shape, render path. Tighten over time as the app
// stabilizes.

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const PERF_PATH = '/tmp/ui-perf.json';

const RICH_RUN = 'run_mogmbj1l_68ah11';

// Routes worth measuring. Home (empty + rich) covers the primary
// surface. /metrics is a fast list. /retro is heavier (full run
// data). Each route gets its own budget.
const ROUTES: Array<{
  label: string;
  url: string;
  // Production budgets (ms). Generous enough that healthy runs pass
  // every time, tight enough that a 2× regression fails.
  ttfb: number;
  fcp: number;
  lcp: number;
}> = [
  { label: 'home-empty',    url: '/',                            ttfb: 800,  fcp: 2000, lcp: 4000 },
  { label: 'home-rich-run', url: `/?swarmRun=${RICH_RUN}`,       ttfb: 1200, fcp: 2500, lcp: 5000 },
  { label: 'metrics',       url: '/metrics',                     ttfb: 800,  fcp: 2000, lcp: 4000 },
  { label: 'retro',         url: `/retro/${RICH_RUN}`,           ttfb: 1200, fcp: 2500, lcp: 5000 },
];

interface PerfMetrics {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  domInteractive: number | null;
  domComplete: number | null;
  transferSize: number | null;
}

async function captureMetrics(page: import('@playwright/test').Page): Promise<PerfMetrics> {
  // Wait long enough that LCP has fired. The largest-contentful-paint
  // entry only stops emitting after user interaction or 1s of
  // inactivity post-paint. waitUntil:'load' + a small settle covers
  // the typical case.
  await page.waitForLoadState('load');
  await page.waitForTimeout(800);
  return await page.evaluate(() => {
    const paint = performance.getEntriesByType('paint');
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const lcpEntries = performance.getEntriesByType(
      'largest-contentful-paint',
    ) as PerformanceEntry[];
    const fcp =
      paint.find((e) => e.name === 'first-contentful-paint')?.startTime ?? null;
    const lcp =
      lcpEntries.length > 0
        ? lcpEntries[lcpEntries.length - 1].startTime
        : null;
    return {
      ttfb: nav ? nav.responseStart : null,
      fcp,
      lcp,
      domInteractive: nav?.domInteractive ?? null,
      domComplete: nav?.domComplete ?? null,
      transferSize: nav?.transferSize ?? null,
    };
  });
}

const allMetrics: Array<{ route: string } & PerfMetrics & {
  budgets: { ttfb: number; fcp: number; lcp: number };
}> = [];

test.beforeAll(() => {
  mkdirSync('/tmp', { recursive: true });
});

test.afterAll(() => {
  // Dump captured metrics for review post-run.
  writeFileSync(PERF_PATH, JSON.stringify(allMetrics, null, 2));
});

for (const route of ROUTES) {
  test(`perf budget · ${route.label}`, async ({ page, browser }) => {
    // Use a fresh context so cache + service-worker state from prior
    // routes don't pre-warm this measurement.
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    await fresh.goto(route.url, { waitUntil: 'domcontentloaded' });
    const metrics = await captureMetrics(fresh);
    await ctx.close();

    allMetrics.push({
      route: route.label,
      ...metrics,
      budgets: { ttfb: route.ttfb, fcp: route.fcp, lcp: route.lcp },
    });

    // Assertions. `null` metrics fail by being smaller-than-zero
    // checks rather than skipping — a missing FCP entry probably
    // means the page didn't actually paint, which is a bigger
    // problem than a slow paint.
    expect(metrics.ttfb, 'TTFB missing').not.toBeNull();
    expect(metrics.fcp, 'FCP missing').not.toBeNull();
    // LCP can legitimately be null on tiny content (no image / large
    // text block ever logged). We accept that, but if it IS reported
    // it must be under budget.
    expect(metrics.ttfb!).toBeLessThan(route.ttfb);
    expect(metrics.fcp!).toBeLessThan(route.fcp);
    if (metrics.lcp !== null) {
      expect(metrics.lcp).toBeLessThan(route.lcp);
    }
  });
}
