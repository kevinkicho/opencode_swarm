// E2E happy-path test for the new-run modal → swarm-run launch flow.
//
// Closes a structural gap in the test suite: the route handler is unit-
// tested, the picker click is verified by Playwright probes, and the
// SSE classifier is unit-tested — but the full flow (open modal → fill
// it out → click launch → POST lands with the right body) had no
// guardrail. A regression that decoupled the form fields from the body
// builder would silently break the only way to spawn a run from the UI.
//
// We don't actually call opencode here; the test intercepts both
// /api/swarm/run (asserts the body shape) and /api/opencode/* (returns
// stubs so the page doesn't 502). This keeps the test fast and isolated
// from backend availability.

import { test, expect } from '@playwright/test';

test('new-run modal POSTs the assembled body with selected fields', async ({ page }) => {
  let capturedRequestBody: unknown = null;

  // Intercept /api/swarm/run POST and capture body, then return a fake
  // success so the modal navigates to the run-detail page.
  await page.route('**/api/swarm/run', async (route) => {
    if (route.request().method() === 'POST') {
      capturedRequestBody = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          swarmRunID: 'run_test_e2e',
          sessionIDs: ['ses_test_1'],
          meta: {
            swarmRunID: 'run_test_e2e',
            pattern: 'blackboard',
            createdAt: Date.now(),
            workspace: '/tmp/test-ws',
            sessionIDs: ['ses_test_1'],
          },
        }),
      });
      return;
    }
    // GET — let it hit the dev server normally
    await route.continue();
  });

  // Stub opencode-side calls so the page mounts without 502s. Empty
  // arrays are accepted by every consumer.
  await page.route('**/api/opencode/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });

  // Stub /api/swarm/providers so the model picker has something to render.
  await page.route('**/api/swarm/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'live',
        fetchedAt: Date.now(),
        providers: [
          {
            id: 'opencode',
            name: 'opencode',
            models: [
              {
                id: 'opencode/glm-4.6',
                modelID: 'glm-4.6',
                providerID: 'opencode',
                label: 'glm-4.6',
                provider: 'go',
                family: 'glm',
                vendor: 'zhipu',
                pricing: { input: 0.35, output: 2 },
                limitTag: 'go 5h $12',
              },
            ],
          },
        ],
      }),
    });
  });

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  // Open the new-run modal. The button is in the topbar.
  await page.locator('button', { hasText: /new run/i }).first().click();

  // The Modal component doesn't carry role="dialog" — wait for its
  // distinctive eyebrow ("initiate") + title ("new run") instead.
  await page.waitForSelector('text=initiate', { state: 'visible', timeout: 5000 });
  // Cheap second sanity check that the form mounted.
  await page.waitForSelector('input[placeholder*="github"]', { timeout: 3000 });

  // Fill source URL.
  await page.locator('input[placeholder*="github"]').first().fill(
    'https://github.com/test/repo',
  );

  // Fill workspace. The modal includes a directory-picker input with a
  // placeholder mentioning the parent path.
  await page
    .locator('input[placeholder*="parent"], input[placeholder*="workspace"], input[placeholder*="directory"]')
    .first()
    .fill('/tmp/test-workspaces');

  // Select the blackboard pattern (default is 'none'). PatternCard is a
  // button whose first child div contains the label — use a `:has-text`
  // narrower than `hasText` (which matches across all descendants and
  // would also match other patterns whose tagline mentions "blackboard").
  await page
    .locator('button')
    .filter({ has: page.locator('div', { hasText: /^blackboard$/i }) })
    .first()
    .click();

  // Add 2 agents by clicking the + stepper twice. The CountStepper
  // renders + and − buttons; we look for + buttons within the modal
  // body (not topbar). Use force:true since the modal animates.
  const plusButton = page.locator('button', { hasText: /^\+$/ }).first();
  await plusButton.waitFor({ state: 'visible', timeout: 3000 });
  await plusButton.click({ force: true });
  await plusButton.click({ force: true });

  // Click launch. Modal launch button text is "launch run" / "launch
  // dry-run" / "launch spectator" depending on startMode (default
  // dry-run).
  const launchBtn = page.locator('button', { hasText: /^launch/i }).first();
  await launchBtn.click();

  // Wait for the POST to land.
  await page.waitForFunction(() => Boolean((window as unknown as { __captured?: unknown }).__captured) || true, {}, { timeout: 5000 });
  // Give Playwright a beat to receive the intercepted POST.
  await page.waitForTimeout(1500);

  expect(capturedRequestBody).toBeTruthy();
  const body = capturedRequestBody as Record<string, unknown>;
  expect(body.pattern).toBe('blackboard');
  expect(body.workspace).toBe('/tmp/test-workspaces');
  expect(body.source).toBe('https://github.com/test/repo');
  // Either 2 of the same model, or no team if the picker didn't bind.
  // Check teamSize was set to 2 from the two + clicks.
  expect(body.teamSize).toBe(2);
  expect(Array.isArray(body.teamModels)).toBe(true);
  expect(body.teamModels).toEqual(['opencode/glm-4.6', 'opencode/glm-4.6']);
});
