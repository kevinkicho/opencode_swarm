// W4.7 verification probe — confirms the run page opens exactly ONE
// EventSource connection per swarmRunID (the multiplexed /board/events
// stream), with no /board/ticker or /strategy poll requests.
//
//   node scripts/_verify-w47-sse.mjs <swarmRunID>
//
// connection per-run page, no /board/ticker or /strategy polls."

import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const swarmRunID = process.argv[2];
if (!swarmRunID) {
  console.error('usage: node scripts/_verify-w47-sse.mjs <swarmRunID>');
  process.exit(1);
}

const port = existsSync('.dev-port')
  ? readFileSync('.dev-port', 'utf8').trim()
  : '49187';
const url = `http://localhost:${port}/?swarmRun=${swarmRunID}`;
console.log(`[verify-w47] target: ${url}\n`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// Track every network request URL pattern
const seen = {
  boardEvents: 0,
  boardTickerPoll: 0,
  strategyPoll: 0,
  other: [],
};

page.on('request', (req) => {
  const u = req.url();
  if (/\/board\/events(\?|$)/.test(u)) {
    seen.boardEvents += 1;
  } else if (/\/board\/ticker(\?|$)/.test(u) && req.method() === 'GET') {
    seen.boardTickerPoll += 1;
  } else if (/\/strategy(\?|$)/.test(u)) {
    seen.strategyPoll += 1;
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
// Generous warmup so SSE settles + lazy chunks compile + ticker hooks mount
await page.waitForTimeout(15_000);
await browser.close();

console.log(`/board/events                 : ${seen.boardEvents} request(s)`);
console.log(`/board/ticker (GET poll)      : ${seen.boardTickerPoll} request(s)`);
console.log(`/strategy (GET poll)          : ${seen.strategyPoll} request(s)`);

const failures = [];
if (seen.boardEvents !== 1) {
  failures.push(`expected exactly 1 /board/events connection, got ${seen.boardEvents}`);
}
if (seen.boardTickerPoll !== 0) {
  failures.push(`expected 0 /board/ticker GET polls, got ${seen.boardTickerPoll}`);
}
// strategy is now SSE-driven, but a ONE-shot cold-load fetch on mount is
// expected (see useStrategy in lib/blackboard/strategy.ts — initial render
// fetches historical revisions, then SSE takes over).
if (seen.strategyPoll > 1) {
  failures.push(`expected ≤1 /strategy fetch (cold-load only), got ${seen.strategyPoll}`);
}

if (failures.length > 0) {
  console.error('\nFAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS — W4.7 SSE-fold verification gate cleared');
