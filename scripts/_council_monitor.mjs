// Background monitor for a single swarm run. Snapshots status / cost / tokens /
// per-session message counts every 30s to an NDJSON log, plus a human-readable
// tail line to stdout. Stops when the run hits idle for 3 consecutive polls
// (council has settled) or after a hard 30-minute cap.
//
// Usage:
//   node scripts/_council_monitor.mjs <swarmRunID> <logPath>

import fs from 'node:fs';

const [, , swarmRunID, logPath] = process.argv;
if (!swarmRunID || !logPath) {
  console.error('usage: node scripts/_council_monitor.mjs <swarmRunID> <logPath>');
  process.exit(2);
}

const PORT = process.env.SMOKE_PORT ?? '49187';
const BASE = `http://localhost:${PORT}`;
const POLL_MS = 30_000;
const IDLE_STREAK_TO_STOP = 3;
const HARD_CAP_MS = 30 * 60 * 1000;

const startedAt = Date.now();
let idleStreak = 0;
let polls = 0;
fs.writeFileSync(logPath, '');

async function poll() {
  polls += 1;
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);

  const row = { ts: Date.now(), elapsedS, polls };
  try {
    const listRes = await fetch(`${BASE}/api/swarm/run`, { cache: 'no-store' });
    const list = await listRes.json();
    const run = list.runs?.find((r) => r.meta?.swarmRunID === swarmRunID);
    if (run) {
      row.status = run.status;
      row.costTotal = run.costTotal;
      row.tokensTotal = run.tokensTotal;
      row.lastActivityTs = run.lastActivityTs;
      row.sinceActivityS = run.lastActivityTs
        ? Math.round((Date.now() - run.lastActivityTs) / 1000)
        : null;
    } else {
      row.error = 'run not in list';
    }
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }

  // Also pull per-session message counts from opencode directly.
  try {
    const sessRes = await fetch(
      `${BASE}/api/swarm/run/${swarmRunID}`,
      { cache: 'no-store' },
    );
    const meta = await sessRes.json();
    row.sessionIDs = meta.sessionIDs ?? [];
  } catch {
    /* ignore */
  }

  fs.appendFileSync(logPath, JSON.stringify(row) + '\n');

  const line =
    `[+${elapsedS.toString().padStart(4)}s] ` +
    `status=${row.status ?? '?'} ` +
    `tok=${(row.tokensTotal ?? 0).toString().padStart(7)} ` +
    `$=${(row.costTotal ?? 0).toFixed(4)} ` +
    `sinceActivity=${row.sinceActivityS ?? '-'}s`;
  console.log(line);

  if (row.status === 'idle' || row.status === 'complete' || row.status === 'done') {
    idleStreak += 1;
  } else {
    idleStreak = 0;
  }

  if (idleStreak >= IDLE_STREAK_TO_STOP) {
    console.log(`[STOP] run idle for ${idleStreak} consecutive polls — session settled`);
    process.exit(0);
  }

  if (Date.now() - startedAt > HARD_CAP_MS) {
    console.log('[STOP] hard 30-minute cap reached');
    process.exit(0);
  }
}

await poll();
setInterval(poll, POLL_MS);
