// Playwright config for the production-build performance probe.
//
// Why a separate config: the existing `playwright.config.ts` points at
// the dev server (read from `.dev-port`). Dev mode has 10–20s cold-
// compile penalty that's inherent to Next.js's HMR pipeline — a perf
// gate against dev would false-positive every fresh start. Production
// builds don't have that penalty (bundles are precompiled), so they
// give a stable baseline against which a real regression is visible.
//
// Lifecycle: the `webServer` block builds the app, starts `next start`
// on PERF_PORT (default 3001), waits for the port to accept
// connections, runs the spec, and tears down. End-to-end ~60–90s.
//
// Run via: `npm run test:perf` (also rebuilds; use --no-build to skip).

import { defineConfig, devices } from '@playwright/test';

const PERF_PORT = Number(process.env.PERF_PORT ?? 3001);
const SKIP_BUILD = process.env.PERF_SKIP_BUILD === '1';

export default defineConfig({
  testDir: './tests/visual',
  testMatch: /perf\.spec\.ts/,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PERF_PORT}`,
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: SKIP_BUILD
      ? `npx next start --port ${PERF_PORT}`
      : `npx next build && npx next start --port ${PERF_PORT}`,
    port: PERF_PORT,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
