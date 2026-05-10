#!/usr/bin/env npx tsx
//
// Auto-screenshot — captures 4 highlight screenshots of opencode_swarm
// in a 2×2 tile grid for GitHub README.
//
// Requirements:
//   1. Dev server running on localhost:8044
//   2. opencode daemon running on :4097
//   3. npm install @playwright/test
//   4. npx playwright install chromium
//
// Run: npx tsx scripts/auto-screenshot.ts

import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE_URL = 'http://localhost:8044';
const OUTPUT_DIR = resolve(process.cwd(), 'public', 'screenshots');
const TILE_OUTPUT = resolve(process.cwd(), 'public', 'screenshots', 'tile-2x2.png');

const VIEWPORT = { width: 1440, height: 900 };

async function capture(name: string, url: string, selector?: string, waitMs?: number) {
  console.log(`[screenshot] capturing: ${name}`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(url, { waitUntil: 'networkidle' });
  if (waitMs) await page.waitForTimeout(waitMs);
  if (selector) await page.waitForSelector(selector, { timeout: 5000 }).catch(() => {});
  const path = join(OUTPUT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await browser.close();
  console.log(`[screenshot] saved: ${path}`);
  return path;
}

async function createTile(paths: string[]) {
  console.log('[screenshot] creating 2x2 tile...');
  const { execSync } = await import('node:child_process');
  
  // Use ImageMagick if available, otherwise just copy files
  try {
    execSync('which magick || which convert', { stdio: 'pipe' });
    // Top row
    execSync(`magick "${paths[0]}" "${paths[1]}" +append /tmp/row1.png`);
    // Bottom row
    execSync(`magick "${paths[2]}" "${paths[3]}" +append /tmp/row2.png`);
    // Full tile
    execSync(`magick /tmp/row1.png /tmp/row2.png -append "${TILE_OUTPUT}"`);
    console.log(`[screenshot] tile saved: ${TILE_OUTPUT}`);
  } catch {
    console.log('[screenshot] ImageMagick not installed — using individual screenshots');
    console.log('[screenshot] tile creation requires: sudo apt install imagemagick (Linux) or brew install imagemagick (macOS)');
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('# Auto-Screenshot — opencode_swarm\n');
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Output: ${OUTPUT_DIR}\n`);

  // Verify dev server is up
  try {
    await fetch(`${BASE_URL}/api/swarm/providers`);
    console.log('  Dev server: UP ✓');
  } catch {
    console.error('  Dev server: DOWN ✗ — start with `npm run dev`');
    process.exit(1);
  }

  // Screenshot 1: New-run modal with pattern recommender
  const s1 = await capture(
    '01-new-run-modal',
    `${BASE_URL}/`,
    undefined,
    2000
  );
  console.log('  1. New-run modal — open with ⌘N, fill directive to see pattern recommender\n');

  // Screenshot 2: Topbar with cost badge + budget warning
  const s2 = await capture(
    '02-topbar-cost-badge',
    `${BASE_URL}/?swarmRun=latest`,
    '[data-topbar]',
    3000
  );
  console.log('  2. Topbar — cost badge, planner error counter, silent session chip\n');

  // Screenshot 3: Board rail with filter chips
  const s3 = await capture(
    '03-board-filters',
    `${BASE_URL}/?swarmRun=latest`,
    '[data-board-rail]',
    2000
  );
  console.log('  3. Board rail — filter chips (status/kind), search input\n');

  // Screenshot 4: Run retro modal
  const s4 = await capture(
    '04-run-retro',
    `${BASE_URL}/?swarmRun=latest`,
    undefined,
    2000
  );
  console.log('  4. Run retro modal — agent scoring table, completion rate\n');

  // Create 2x2 tile
  await createTile([s1, s2, s3, s4]);

  // Generate README markdown snippet
  const md = `
## Screenshots

<p align="center">
  <img src="public/screenshots/tile-2x2.png" alt="opencode_swarm highlights" width="800" />
</p>

### Individual captures

1. **New-run modal** — pattern recommender chip + template dropdown + cost-per-todo badge
2. **Topbar** — run status, cost badge, planner error counter, silent session chip
3. **Board rail** — filter chips (open/in-progress/done/stale + todo/criterion/finding)
4. **Run retro** — post-hoc review with agent scoring table and completion rate
`;
  writeFileSync(join(OUTPUT_DIR, 'README.md'), md.trimStart(), 'utf8');
  console.log(`\n[screenshot] README snippet saved: ${OUTPUT_DIR}/README.md`);
  console.log('[screenshot] Done. Update README.md with the tile image reference above.');
}

main().catch((err) => {
  console.error('[screenshot] failed:', err.message);
  process.exit(1);
});
