// One-shot Lighthouse runner for the app.
//
// Usage:
//   npm run perf:lighthouse:dev        — profile the currently-running dev server
//   npm run perf:lighthouse:prod       — profile a locally-running `next start`
//   npm run perf:lighthouse <URL>      — profile an arbitrary URL
//
// Reads `.dev-port` (written by scripts/dev.mjs) so the dev mode always hits
// the right dynamic port without the user having to remember it. Prod mode
// assumes the default `next start` port (3000). Both modes only profile the
// performance category — Lighthouse's accessibility / SEO / best-practices
// categories aren't actionable for an internal tool.
//
// Dev-mode numbers are misleadingly slow (on-demand compile, no minification,
// strict-mode double renders). Use dev-mode results to compare *relative*
// slowness between navigations; use prod-mode results for absolute numbers.
//
// If Lighthouse can't find Chrome, the command will fail with a clear error.
// On WSL, the simplest fix is to install Chrome inside WSL
// (`sudo apt install -y chromium-browser`) or run this script from Windows
// PowerShell where Chrome is already installed.

import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const MODE = process.argv[2] ?? 'dev';

function resolveUrl() {
  if (MODE.startsWith('http://') || MODE.startsWith('https://')) return MODE;
  if (MODE === 'dev') {
    if (!existsSync('.dev-port')) {
      console.error(
        '[perf-lighthouse] .dev-port missing — start the dev server first (npm run dev).',
      );
      process.exit(1);
    }
    const port = readFileSync('.dev-port', 'utf8').trim();
    return `http://localhost:${port}/`;
  }
  if (MODE === 'prod') return 'http://localhost:3000/';
  console.error(`[perf-lighthouse] unknown mode '${MODE}' — expected dev | prod | <URL>`);
  process.exit(1);
}

const url = resolveUrl();
console.log(`[perf-lighthouse] profiling ${url} (mode=${MODE})\n`);

const args = [
  'lighthouse',
  url,
  '--only-categories=performance',
  '--view',
  '--chrome-flags=--headless=new',
  '--output=html',
  `--output-path=./.perf/lighthouse-${MODE}-${Date.now()}.html`,
];

const child = spawn('npx', args, { stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
