// Playwright config for CI — scoped to the golden-path lifecycle test.
//
// The visual baselines under tests/visual/ need pixel-stable rendering
// against the dev server with the operator's local opencode reachable.
// CI doesn't have either, so this config:
//   - runs only run-lifecycle.spec.ts (pure HTTP-interception, no
//     pixel diffs, no live opencode)
//   - boots its own production Next.js server via `webServer`, no
//     .dev-port plumbing
//   - chromium only (no need for cross-browser at this level)
//
// The visual + perf configs stay separate; they're operator-local.

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: './tests/visual',
  testMatch: /run-lifecycle\.spec\.ts/,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
