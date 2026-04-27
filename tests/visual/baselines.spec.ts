// Visual regression baselines.
//
// First run captures one baseline PNG per snapshot under
// `tests/visual/__screenshots__/`. Subsequent runs diff against the
// baseline; any pixel-diff over the configured tolerance fails the
// test with a saved diff image showing exactly what changed.
//
// To re-baseline (e.g. after an intentional CSS change):
//   npx playwright test --update-snapshots tests/visual
//
// To run:
//   npx playwright test tests/visual
//
// Requires the dev server to be up — we read the port from .dev-port
// (same source as the smoke scripts).
//
// Stability: the picker test stubs /api/swarm/run with a frozen fixture
// so the row count + content don't drift between captures. Without
// stubbing, every poll cycle would shift "X of Y" header text and
// silently fail the diff.

import { test, expect } from '@playwright/test';

const RICH_RUN = 'run_mogmbj1l_68ah11';

// Three frozen rows for the picker visual baseline. Stable across runs
// regardless of what's actually in the registry. createdAt values are
// chosen so the alive bucket sorts above stale.
const PICKER_FIXTURE = {
  runs: [
    {
      meta: {
        swarmRunID: 'run_visualbase_001',
        pattern: 'none',
        createdAt: 1_700_000_000_000,
        workspace: '/tmp/visual-fixture',
        sessionIDs: ['ses_visualbase_001'],
        directive: 'visual baseline · live row',
        title: 'baseline live',
      },
      status: 'live',
      lastActivityTs: 1_700_000_000_000,
      costTotal: 0.42,
      tokensTotal: 12345,
    },
    {
      meta: {
        swarmRunID: 'run_visualbase_002',
        pattern: 'council',
        createdAt: 1_699_999_000_000,
        workspace: '/tmp/visual-fixture',
        sessionIDs: ['ses_visualbase_002a', 'ses_visualbase_002b'],
        directive: 'visual baseline · stale row',
        title: 'baseline stale',
      },
      status: 'stale',
      lastActivityTs: 1_699_999_000_000,
      costTotal: 1.23,
      tokensTotal: 45678,
    },
    {
      meta: {
        swarmRunID: 'run_visualbase_003',
        pattern: 'blackboard',
        createdAt: 1_699_998_000_000,
        workspace: '/tmp/visual-fixture',
        sessionIDs: ['ses_visualbase_003'],
        directive: 'visual baseline · error row',
        title: 'baseline error',
      },
      status: 'error',
      lastActivityTs: 1_699_998_000_000,
      costTotal: 0.05,
      tokensTotal: 999,
    },
  ],
};

// Suppress the indexed-DB-driven react-query devtools chrome and the
// react-scan dev probe so they don't pollute the baseline. Both are
// dev-only so this CSS only matters for visual tests.
const HIDE_DEV_OVERLAYS = `
  [data-react-scan],
  [class*="ReactQueryDevtools"],
  iframe#react-scan-toolbar { visibility: hidden !important; }
  /* Disable any animations / transitions that would otherwise
     capture mid-frame even with Playwright's animations:'disabled'. */
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

test.describe('visual baselines', () => {
  test('home (no run selected)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: HIDE_DEV_OVERLAYS });
    // Settle: hydration + initial /api/swarm/run poll
    await page.waitForTimeout(2000);
    await expect(page).toHaveScreenshot('home.png', { fullPage: true });
  });

  test('home with rich run pre-selected', async ({ page }) => {
    await page.goto(`/?swarmRun=${RICH_RUN}`, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: HIDE_DEV_OVERLAYS });
    await page.waitForTimeout(3500);
    await expect(page).toHaveScreenshot('home-rich-run.png', { fullPage: true });
  });

  test('runs picker open', async ({ page }) => {
    // Freeze /api/swarm/run so the picker baseline is reproducible.
    // Without this, every poll mutates the row count and the diff
    // grows past tolerance.
    await page.route('**/api/swarm/run', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(PICKER_FIXTURE),
        });
      }
      return route.continue();
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: HIDE_DEV_OVERLAYS });
    await page.waitForTimeout(2000);
    const trigger = page.locator('button', { hasText: 'runs' }).first();
    await trigger.click({ timeout: 3000 });
    // Popover-mount + auto-update-position settle
    await page.waitForTimeout(1500);
    await expect(page).toHaveScreenshot('picker-open.png', { fullPage: true });
  });
});
