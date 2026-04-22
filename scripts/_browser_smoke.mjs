// Headless browser diagnostic for the run view. Launches a fresh Chrome
// against a dedicated profile (so no interference with the user's real
// browser), drives the three surfaces we need to smoke-test, and prints a
// single structured report to stdout.
//
// Usage:
//   node scripts/_browser_smoke.mjs [swarmRunID]
// Default swarmRunID matches the blackboard run used in the handover.

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const PORT = process.env.SMOKE_PORT ?? '49187';
const SWARM_RUN = process.argv[2] ?? 'run_mo9jbfae_crx58n';
const BASE = `http://localhost:${PORT}`;
const ROOT = `${BASE}/?swarmRun=${SWARM_RUN}`;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('no Chrome or Edge found');
  process.exit(1);
}

const userDataDir = path.join(os.tmpdir(), `swarm-smoke-${Date.now()}`);

const consoleLines = [];
const pageErrors = [];
const requests = [];
const responses = [];

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  page.on('console', (msg) => {
    consoleLines.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('request', (req) => {
    if (req.url().startsWith(BASE)) {
      requests.push({ method: req.method(), url: req.url() });
    }
  });
  page.on('response', (res) => {
    if (res.url().startsWith(BASE)) {
      responses.push({ status: res.status(), url: res.url() });
    }
  });

  log('NAV', `→ ${ROOT}`);
  const nav = await page
    .goto(ROOT, { waitUntil: 'networkidle2', timeout: 20000 })
    .catch((e) => ({ error: e.message }));
  if (nav && 'error' in nav) {
    log('NAV', 'FAILED:', nav.error);
  } else {
    log('NAV', `status ${nav?.status()}`);
  }

  await new Promise((r) => setTimeout(r, 1500));

  // Shell check: is the tab bar present?
  const shell = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('button')).map((b) =>
      (b.textContent || '').trim(),
    );
    return {
      title: document.title,
      hasBoardTab: tabs.some((t) => /^board/i.test(t)),
      tabs: tabs.filter((t) => /^(plan|roster|board)/i.test(t)),
      bodyBytes: document.body.innerHTML.length,
    };
  });
  log('SHELL', JSON.stringify(shell));

  if (!shell.hasBoardTab) {
    log(
      'SHELL',
      'no board tab found — either the run is not blackboard or the page never hydrated',
    );
  } else {
    // Click the board tab.
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /^board/i.test((b.textContent || '').trim()),
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    log('CLICK_BOARD_TAB', clicked ? 'clicked' : 'button not found');

    await new Promise((r) => setTimeout(r, 4000)); // give polling a chance

    const boardState = await page.evaluate(() => {
      const txt = (document.body.innerText || '').toLowerCase();
      const link = Array.from(document.querySelectorAll('a')).find((a) =>
        /full board/i.test((a.textContent || '').trim()),
      );
      return {
        hasLoading: txt.includes('loading…') || txt.includes('loading...'),
        hasTickerLabel: txt.includes('ticker'),
        hasNone: txt.includes('none'),
        hasFullBoardLink: Boolean(link),
        fullBoardHref: link?.getAttribute('href') ?? null,
      };
    });
    log('BOARD_STATE', JSON.stringify(boardState));

    // Click the full board link via JS navigation fallback.
    if (boardState.hasFullBoardLink) {
      const beforeUrl = page.url();
      await page.evaluate(() => {
        const link = Array.from(document.querySelectorAll('a')).find((a) =>
          /full board/i.test((a.textContent || '').trim()),
        );
        link?.click();
      });
      await new Promise((r) => setTimeout(r, 2000));
      const afterUrl = page.url();
      log('FULL_BOARD_CLICK', `${beforeUrl} → ${afterUrl}`);
    }
  }

  // Also hit /metrics directly.
  log('NAV', `→ ${BASE}/metrics`);
  const mResp = await page
    .goto(`${BASE}/metrics`, { waitUntil: 'networkidle2', timeout: 15000 })
    .catch((e) => ({ error: e.message }));
  if (mResp && 'error' in mResp) {
    log('METRICS_NAV', 'FAILED:', mResp.error);
  } else {
    log('METRICS_NAV', `status ${mResp?.status()}`);
    const metricsState = await page.evaluate(() => {
      const txt = (document.body.innerText || '').toLowerCase();
      return {
        hasPatternsHeading: txt.includes('cross-preset') || txt.includes('metrics'),
        hasBlackboardRow: txt.includes('blackboard'),
        hasCouncilRow: txt.includes('council'),
        bodyBytes: document.body.innerHTML.length,
      };
    });
    log('METRICS_STATE', JSON.stringify(metricsState));
  }
} finally {
  await browser.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

console.log('\n==== REPORT ====');
console.log(`console.log/warn/error lines: ${consoleLines.length}`);
const errors = consoleLines.filter((c) => c.type === 'error');
if (errors.length) {
  console.log('--- CONSOLE ERRORS ---');
  errors.forEach((e) => console.log(`  [${e.type}] ${e.text}`));
}
const warnings = consoleLines.filter((c) => c.type === 'warning' || c.type === 'warn');
if (warnings.length) {
  console.log('--- CONSOLE WARNINGS ---');
  warnings.slice(0, 10).forEach((e) => console.log(`  [${e.type}] ${e.text}`));
}
if (pageErrors.length) {
  console.log('--- UNCAUGHT PAGE ERRORS ---');
  pageErrors.forEach((e) => console.log(`  ${e}`));
}
console.log(`\nlocal requests: ${requests.length}`);
const apiHits = responses.filter((r) => r.url.includes('/api/'));
console.log(`api responses: ${apiHits.length}`);
const byPath = new Map();
for (const r of apiHits) {
  const u = new URL(r.url);
  const key = `${r.status} ${u.pathname}`;
  byPath.set(key, (byPath.get(key) ?? 0) + 1);
}
for (const [k, n] of [...byPath.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(3)} × ${k}`);
}

const nonOk = responses.filter((r) => r.status >= 400);
if (nonOk.length) {
  console.log('--- NON-OK RESPONSES ---');
  nonOk.slice(0, 15).forEach((r) => console.log(`  ${r.status} ${r.url}`));
}
