// Distinguishes Zen free-tier 429 rate-limiting from a genuine opencode
// process freeze. Both look identical to the liveness watchdog ("no
// token delta in 10 min"), but the recovery paths are different:
//
//   rate-limit → self-healing; wait out retry-after header (hours)
//   frozen     → needs opencode process restart
//
// The watchdog calls `detectRecentZen429()` before declaring a freeze.
// If a recent 429 is in the opencode log, stopReason becomes
// `zen-rate-limit` (with retry-after seconds if parseable); otherwise
// it falls through to `opencode-frozen`.
//
// Implementation: read the tail of the latest opencode log file, grep
// for `statusCode":429` entries with a timestamp within the last N
// minutes. Opencode logs are written to XDG_DATA_HOME/opencode/log/;
// under WSL we see them at /mnt/c/Users/kevin/.opencode-ui-separate/
// opencode/log/ by convention (see memory/reference_opencode_port.md).
// Overridable via OPENCODE_LOG_DIR env for other hosts.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_LOG_DIR =
  '/mnt/c/Users/kevin/.opencode-ui-separate/opencode/log';
const LOOKBACK_MS = 5 * 60 * 1000;
const TAIL_BYTES = 512 * 1024;

// Opencode log line format we care about:
// `ERROR 2026-04-23T19:05:26 +3ms service=llm ... statusCode":429 ...`
// ISO-8601 to milliseconds. The literal `statusCode":429` comes from
// the embedded error JSON.
const LINE_RE =
  /^\w+\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})[^\n]*?statusCode":429[^\n]*/gm;
const RETRY_AFTER_RE = /"retry-after":"?(\d+)"?/;

export interface RateLimitSignal {
  found: boolean;
  lastHitAt?: number; // epoch ms of most recent 429 in the window
  retryAfterSec?: number;
}

async function latestLogFile(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir);
    const logs = entries
      .filter((e) => e.endsWith('.log'))
      .sort()
      .reverse();
    return logs.length > 0 ? path.join(dir, logs[0]) : null;
  } catch {
    return null;
  }
}

async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function detectRecentZen429(): Promise<RateLimitSignal> {
  const dir = process.env.OPENCODE_LOG_DIR || DEFAULT_LOG_DIR;
  try {
    const file = await latestLogFile(dir);
    if (!file) return { found: false };
    const tail = await readTail(file, TAIL_BYTES);
    const now = Date.now();
    let lastHitAt: number | undefined;
    let retryAfterSec: number | undefined;
    LINE_RE.lastIndex = 0;
    for (
      let m = LINE_RE.exec(tail);
      m !== null;
      m = LINE_RE.exec(tail)
    ) {
      const ts = Date.parse(m[1] + 'Z'); // assume UTC
      if (Number.isNaN(ts)) continue;
      if (now - ts > LOOKBACK_MS) continue;
      if (lastHitAt == null || ts > lastHitAt) lastHitAt = ts;
      const ra = RETRY_AFTER_RE.exec(m[0]);
      if (ra) {
        const sec = parseInt(ra[1], 10);
        if (Number.isFinite(sec)) retryAfterSec = sec;
      }
    }
    if (lastHitAt == null) return { found: false };
    return { found: true, lastHitAt, retryAfterSec };
  } catch {
    return { found: false };
  }
}

// Formats a retry-after duration for log / UI display. Short-circuits
// the sub-minute case since "0h 0m" reads worse than "<1m".
export function formatRetryAfter(sec: number | undefined): string {
  if (sec === undefined || sec <= 0) return 'unknown';
  if (sec < 60) return '<1m';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
