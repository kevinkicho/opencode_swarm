// Full UI/UX sweep — every route, every viewport, every probe.
//
// Why this exists: ad-hoc Playwright probes have repeatedly missed
// findings (the 768px overflow snuck past until it was specifically
// asked for). This sweep is the durable replacement: one test file
// that runs the same exhaustive battery against every route at every
// breakpoint and writes a structured findings JSON for review.
//
// Probes per route × viewport:
//   - axe a11y (full ruleset minus 'region' which our chip-density UI
//     legitimately fails — landmark structure isn't meaningful when
//     the dense factory has a single primary surface)
//   - console errors + warnings (filtered for app-relevant noise)
//   - uncaught page errors
//   - failed network requests (excluding RSC prefetch noise)
//   - long DOM hydrations / heavy nodes
//
// Output goes to /tmp/ui-sweep.json so it's readable post-run. Each
// `test()` is also a hard pass/fail gate — anything new that violates
// the ruleset will turn the run red.

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const RICH_RUN = 'run_mogmbj1l_68ah11';
const PROJECT_SLUG = 'kyahoofinance032926';

const ROUTES = [
  { label: 'home-empty', url: '/' },
  { label: 'home-rich-run', url: `/?swarmRun=${RICH_RUN}` },
  { label: 'metrics', url: '/metrics' },
  { label: 'projects', url: '/projects' },
  { label: 'project-detail', url: `/projects/${PROJECT_SLUG}` },
  { label: 'retro', url: `/retro/${RICH_RUN}` },
  { label: 'board-preview', url: `/board-preview?swarmRun=${RICH_RUN}` },
  { label: 'debug-opencode', url: '/debug/opencode' },
];

// Aggregate findings across all `test()` invocations into one file so
// the final summary lands in /tmp/ui-sweep.json. We append to the file;
// a beforeAll wipes it on a fresh run.
const FINDINGS_PATH = '/tmp/ui-sweep.json';

type Finding = {
  route: string;
  viewport: string;
  axeViolations: Array<{ id: string; impact: string | null; nodes: number; help: string; firstNode: string }>;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: Array<{ url: string; reason: string }>;
  // 5xx responses on /api/* — Playwright's `requestfailed` event
  // doesn't fire on completed-with-error responses, so a 500 from
  // a route handler is invisible without this separate channel.
  // Added 2026-04-27 after a real /api/swarm/run 500 went uncaught.
  apiServerErrors: Array<{ url: string; status: number }>;
  // Heuristic: warn if rendered text is very short on a route that
  // should have content. Surfaces hard-render failures that aren't
  // necessarily console errors.
  textLength: number;
  domNodes: number;
};

function appendFinding(f: Finding) {
  let prior: Finding[] = [];
  if (existsSync(FINDINGS_PATH)) {
    try {
      prior = JSON.parse(readFileSync(FINDINGS_PATH, 'utf8'));
    } catch {
      prior = [];
    }
  }
  prior.push(f);
  writeFileSync(FINDINGS_PATH, JSON.stringify(prior, null, 2));
}

// Don't wipe in beforeAll — Playwright runs beforeAll once per project,
// which with 3 projects would clobber the prior project's findings.
// `npm run test:visual:sweep` script removes the file before invoking
// playwright; manual invocations should `rm /tmp/ui-sweep.json` first
// for a clean run.
test.beforeAll(() => {
  mkdirSync('/tmp', { recursive: true });
});

// One test() per (route, viewport). Playwright runs them across the
// configured projects (chromium-desktop / -narrow / -mobile) so this
// expands to ROUTES.length × 3 = 24 actual test runs.
for (const route of ROUTES) {
  test(`sweep ${route.label}`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: Array<{ url: string; reason: string }> = [];
    const apiServerErrors: Array<{ url: string; status: number }> = [];

    page.on('response', (resp) => {
      const url = resp.url();
      if (!url.includes('/api/')) return;
      const status = resp.status();
      if (status >= 500) {
        apiServerErrors.push({
          url: url.replace(/https?:\/\/localhost:\d+/, ''),
          status,
        });
      }
    });

    page.on('console', (m) => {
      const type = m.type();
      const text = m.text().slice(0, 240);
      if (type === 'error') consoleErrors.push(text);
      else if (type === 'warning') consoleWarnings.push(text);
    });
    page.on('pageerror', (e) => {
      pageErrors.push(String(e).slice(0, 240));
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      // Filter known noise:
      //   - RSC prefetch aborts (Next.js fires these on nav, expected)
      //   - turbopack hot-update probes
      //   - opencode session diff endpoints (shape allows misses)
      if (url.includes('_rsc=') || url.includes('hot-update') || url.includes('/diff'))
        return;
      const f = req.failure();
      failedRequests.push({
        url: url.replace(/https?:\/\/localhost:\d+/, ''),
        reason: f?.errorText ?? 'unknown',
      });
    });

    await page.goto(route.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Settle for hydration + initial poll/SSE wiring. Rich-run pages
    // need longer because the timeline does its own layout pass.
    await page.waitForTimeout(route.label === 'home-rich-run' ? 4500 : 2500);

    // Capture render stats before tearing down.
    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const textLength = await page.evaluate(() => (document.body?.innerText ?? '').length);

    // axe — skip rules that conflict with deliberate design choices.
    // `region` was previously disabled but it surfaced a real bug
    // (sr-only h1 + composer textarea outside any landmark on home),
    // so it's now ENABLED. Remaining opt-outs:
    //   - 'color-contrast': the muted text-fog-600/700 palette is
    //     intentional for the dense secondary-information layer.
    //     Bumping to WCAG AA (#6c7480+) breaks the visual language.
    //     Documented decision; ~500 nodes affected.
    //   - 'scrollable-region-focusable': mobile-only edge case in
    //     scroll containers whose interior IS keyboard-reachable but
    //     axe can't statically infer it. Keeping the rule disabled
    //     until we ship mobile UX as a primary surface.
    const axeResults = await new AxeBuilder({ page })
      .disableRules(['color-contrast', 'scrollable-region-focusable'])
      .analyze();

    const axeViolations = axeResults.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      nodes: v.nodes.length,
      help: v.help,
      firstNode: v.nodes[0]?.html?.slice(0, 160) ?? '',
    }));

    // Filter known dev-only console noise that's not a bug. Anything
    // not matched here is captured for review.
    const realConsoleErrors = consoleErrors.filter((e) => {
      if (e.includes('Download the React DevTools')) return false;
      if (e.includes('[Fast Refresh]')) return false;
      if (e.includes('hot-update')) return false;
      // @axe-core/react dev probe pipes findings through console.error
      // with a recognizable preamble. We capture axe results from our
      // own AxeBuilder above, so dedupe these.
      if (e.includes('Fix any of the following:')) return false;
      if (e.includes('You can find more information')) return false;
      if (/^(serious|critical|moderate|minor)\b/.test(e)) return false;
      // Next.js dev-only "static generation" warnings on dynamic routes
      if (e.includes('useSearchParams') && e.includes('Suspense')) return false;
      return true;
    });

    appendFinding({
      route: route.label,
      viewport: testInfo.project.name,
      axeViolations,
      consoleErrors: realConsoleErrors,
      consoleWarnings,
      pageErrors,
      failedRequests,
      apiServerErrors,
      textLength,
      domNodes,
    });

    // Hard-fail gates. Anything new past these gates is a regression
    // we want to catch in CI:
    //
    //   - Page errors: any uncaught exception is a real crash.
    //   - Real console errors: post-filter for known dev noise. Empty
    //     means React isn't logging warnings (forwardRef, key-prop,
    //     unmounted-setState, etc.).
    //   - Critical + serious axe: with the three opt-out rules above
    //     disabled (region, color-contrast, scrollable-region-focusable),
    //     anything still landing here is a real a11y bug.
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
    expect(
      realConsoleErrors,
      `Real console errors:\n${realConsoleErrors.join('\n')}`,
    ).toEqual([]);

    // Hard fail on any /api/* 5xx. The route handlers ARE the data
    // source for the picker / timeline / inspector — a 500 here is
    // never "expected" the way a /debug/opencode 4xx might be.
    expect(
      apiServerErrors,
      `5xx responses from /api/*:\n${JSON.stringify(apiServerErrors, null, 2)}`,
    ).toEqual([]);

    const seriousOrCritical = axeViolations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    expect(
      seriousOrCritical,
      `Serious/critical axe violations:\n${JSON.stringify(seriousOrCritical, null, 2)}`,
    ).toEqual([]);
  });
}
