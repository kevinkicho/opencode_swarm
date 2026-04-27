// Playwright config — scoped to visual regression tests only.
//
// We already use the `playwright` library directly for ad-hoc smoke
// scripts under scripts/_*_smoke.mjs (no test runner involved). This
// config is for the @playwright/test runner, used for the visual
// regression baselines under tests/visual/.
//
// The two coexist: smoke scripts stay under scripts/ as standalone
// .mjs files; visual regression lives in tests/visual/ and runs via
// `npx playwright test`.

import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Read the dev-server port from the same .dev-port file the smoke
// scripts use. Falls back to 3000 for local invocations without the
// dev manager running. The visual test reads window.location relative
// to baseURL so baselines stay stable across port changes.
let devPort = '3000';
try {
  devPort = readFileSync('.dev-port', 'utf8').trim() || '3000';
} catch {
  // .dev-port absent → caller must `npm run dev` first
}

export default defineConfig({
  testDir: './tests/visual',
  // Visual diffs need pixel-stable rendering — single worker prevents
  // timing variance from parallel paint cycles.
  workers: 1,
  // No retries: a flaky visual test means an unstable baseline, not
  // something to retry past.
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${devPort}`,
    // Disable animations so transitions don't capture mid-frame.
    // Playwright honors prefers-reduced-motion via emulation.
    colorScheme: 'dark',
    viewport: { width: 1440, height: 900 },
  },
  expect: {
    // 1.5% pixel-diff tolerance — enough to ignore subpixel anti-alias
    // drift between runs while still catching real CSS regressions.
    // Tighten if too lenient.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.015,
      animations: 'disabled',
    },
  },
  // Three viewport projects so the overflow probe runs at every
  // breakpoint we care about. Narrow regressions (the 768px timeline
  // overflow that snuck past the original baseline) only catch when we
  // actually render at narrow widths — single-viewport baselines miss
  // these by construction.
  //
  // Visual baseline diffs (baselines.spec.ts) are scoped to desktop only
  // via testIgnore on the narrow + mobile projects — keeping 9 PNGs
  // instead of 3 isn't worth the maintenance cost when the structural
  // overflow probe already covers narrow correctness.
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 900 } },
      testIgnore: /baselines\.spec\.ts/,
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
      testIgnore: /baselines\.spec\.ts/,
    },
  ],
});
