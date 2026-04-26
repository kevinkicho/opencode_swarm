// Tail opencode's log file into the Next.js dev server stdout.
// POSTMORTEMS/2026-04-24 F2.
//
// The 2026-04-24 silent-failure postmortem identified that opencode's
// errors and provider-dispatch logs are invisible from our app's
// position — they live in `~/.local/share/opencode/log/<ts>.log` on
// the host running opencode (Windows, accessed via the WSL mount).
// During a 15-min hang, our dev console showed nothing, but the
// opencode log might have shown the actual problem. F2 wires the
// log to dev stdout so failures surface in real time.
//
// Implementation: poll-based tail. We resolve the newest .log file
// in the log directory at startup, remember our position, and on
// each tick read newly appended bytes. Simpler than fs.watch on the
// WSL-mounted Windows filesystem (file events are unreliable across
// the mount); poll cadence is 1s, line latency under 2s end-to-end.
//
// Filtering: opencode emits ~100 file.watcher.updated events per
// second when a workspace's files change during a sweep. Those drown
// the signal. We filter them out + the periodic snapshot-prune
// chatter; everything else flows to stdout with `[opencode]` prefix.
//
// Lifecycle: start once on dev-server init via instrumentation.ts.
// The startup is idempotent — repeated calls (HMR reload) don't
// stack timers.

// Bare module specifiers (not node:-prefixed) — webpack's default
// loader chain doesn't resolve `node:` URIs in dev mode, even though
// Node itself accepts both. The `node:` form would block any API
// route that transitively imports this file.
import { existsSync, readdirSync, statSync, openSync, closeSync, readSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Default log dir matches the documented path on the user's host —
// see memory/reference_opencode_4097_launcher.md. Override via env
// for unusual installs.
function defaultLogDir(): string {
  const env = process.env.OPENCODE_LOG_DIR;
  if (env) return env;
  return path.join(homedir(), '.local', 'share', 'opencode', 'log');
}

// Cross-platform default — Windows-side opencode writes to
// %LOCALAPPDATA%\opencode\log; the wsl-mounted equivalent is
// /mnt/c/Users/<user>/.local/share/opencode/log when the daemon
// runs in WSL. The user's setup runs opencode on Windows, so the
// /mnt/c path is the right default.
function fallbackWindowsLogDir(): string {
  // /mnt/c/Users/<user>/.local/share/opencode/log
  // Read $USER from env; fallback to walking /mnt/c/Users for a
  // single non-Public user dir if the env var is missing. The fallback
  // is only useful on the developer's own machine — on a fresh clone
  // OPENCODE_LOG_DIR should be set explicitly.
  const user = process.env.WSL_USER ?? process.env.USER;
  if (!user) return '';
  return `/mnt/c/Users/${user}/.local/share/opencode/log`;
}

// Find the most-recently-modified .log file in the directory.
// Returns null if the directory doesn't exist or has no .log files.
function findActiveLog(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let latest: { full: string; mtime: number } | null = null;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.log')) continue;
      const full = path.join(dir, entry);
      try {
        const s = statSync(full);
        if (!s.isFile()) continue;
        const m = s.mtimeMs;
        if (latest === null || m > latest.mtime) {
          latest = { full, mtime: m };
        }
      } catch {
        // Single file unreadable — skip and continue.
      }
    }
  } catch {
    return null;
  }
  return latest?.full ?? null;
}

// Lines opencode emits at high frequency that drown the interesting
// signal. The 2026-04-24 postmortem confirmed `file.watcher.updated`
// alone produces hundreds of lines per minute during a sweep — those
// are the workspace's files being touched as workers commit, not
// errors we want to see.
//
// 2026-04-26 audit: `ERROR service=server error= failed` fires every
// 30s with an empty error field, regardless of what our app does.
// Opencode's POST/SSE traffic keeps working through it; appears to be
// an internal periodic check that's logged at ERROR level even on
// normal operation. 179 occurrences observed in a 1h dev session,
// drowning the actual error signal we wired F2 to surface. Filter it
// here. If a real "service=server" failure ever surfaces, opencode
// would log distinct error detail (e.g. error="ECONNREFUSED ...")
// which our regex doesn't match, so this filter is conservative.
const NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /service=bus type=file\.watcher\.updated\b/,
  /service=snapshot prune=/,
  /service=bus type=session\.idle\b/,
  /^ERROR\s+\S+\s+\+\d+ms\s+service=server\s+error=\s+failed\s*$/,
];

function isNoise(line: string): boolean {
  for (const re of NOISE_PATTERNS) if (re.test(line)) return true;
  return false;
}

interface TailState {
  filePath: string;
  position: number;
  buffer: string;
  timer: ReturnType<typeof setInterval> | null;
}

// 2026-04-25 #90 fix — state was module-scoped, but Next.js HMR
// reloads modules on every edit. After reload the new module sees
// state=null and starts ANOTHER setInterval; the old module's timer
// keeps running too. Result: dozens of "starting (F2)" log lines per
// dev session and N concurrent tails reading the same file. Pattern
// fix: stash state on globalThis with a Symbol key so HMR module
// reloads see the same single instance and the idempotency check
// actually idempotent.
const TAIL_STATE_KEY = Symbol.for('opencode_swarm.opencodeLogTail.state');
type GlobalWithTail = typeof globalThis & {
  [TAIL_STATE_KEY]?: TailState | null;
};
function getState(): TailState | null {
  return (globalThis as GlobalWithTail)[TAIL_STATE_KEY] ?? null;
}
function setState(value: TailState | null): void {
  (globalThis as GlobalWithTail)[TAIL_STATE_KEY] = value;
}

function tickTail(s: TailState): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(s.filePath);
  } catch {
    // Log file vanished (rotation in progress, machine offline). Drop
    // back to discovery — the next tick re-resolves the active file.
    s.position = 0;
    s.filePath = '';
    return;
  }
  if (stat.size < s.position) {
    // File was truncated (rotation, daemon restart); reset to start.
    s.position = 0;
  }
  if (stat.size === s.position) return;

  // Read everything since last position. We allocate a fresh buffer
  // each tick because most ticks have a small tail (<8 KB); a
  // long-running buffer would just waste memory between ticks.
  const toRead = stat.size - s.position;
  const buf = Buffer.alloc(toRead);
  let fd: number;
  try {
    fd = openSync(s.filePath, 'r');
  } catch {
    return;
  }
  try {
    readSync(fd, buf, 0, toRead, s.position);
  } catch {
    closeSync(fd);
    return;
  }
  closeSync(fd);
  s.position = stat.size;

  const text = buf.toString('utf8');
  // Append to any leftover partial line from the prior tick.
  s.buffer += text;
  let nl = s.buffer.indexOf('\n');
  while (nl >= 0) {
    const line = s.buffer.slice(0, nl).replace(/\r$/, '');
    s.buffer = s.buffer.slice(nl + 1);
    if (line.length > 0 && !isNoise(line)) {
      // Forward to stdout with prefix. console.log because that's
      // what Next.js's dev pipe expects; we don't want to hijack
      // stderr for non-errors.
      console.log(`[opencode] ${line}`);
    }
    nl = s.buffer.indexOf('\n');
  }
}

function discoveryTick(): void {
  const s = getState();
  if (!s) return;
  if (s.filePath && existsSync(s.filePath)) {
    tickTail(s);
    return;
  }
  // No active file yet OR the previous one vanished. Re-resolve.
  const candidates = [defaultLogDir(), fallbackWindowsLogDir()].filter(Boolean);
  for (const dir of candidates) {
    const found = findActiveLog(dir);
    if (found) {
      console.log(`[opencode-log-tail] tailing ${found}`);
      s.filePath = found;
      // Start at the end — we don't replay history on first attach,
      // since it'd flood the dev console with log entries from
      // before this server boot.
      try {
        s.position = statSync(found).size;
      } catch {
        s.position = 0;
      }
      s.buffer = '';
      return;
    }
  }
}

const POLL_INTERVAL_MS = 1000;
const DISCOVERY_INTERVAL_MS = 5000;

export function startOpencodeLogTail(): void {
  // Idempotency: globalThis-keyed state survives HMR module reloads,
  // so a second import after an edit sees the existing timer and
  // returns without starting a duplicate.
  const existing = getState();
  if (existing?.timer) return;
  console.log('[opencode-log-tail] starting (F2)');
  const s: TailState = {
    filePath: '',
    position: 0,
    buffer: '',
    timer: null,
  };
  setState(s);
  // Two cadences: fast tail (1s) + slower file-discovery (5s) for the
  // case where opencode hasn't started yet on dev-server boot. We
  // implement them as one interval that branches based on whether
  // we have a file open; saves a timer slot.
  s.timer = setInterval(() => {
    const cur = getState();
    if (!cur) return;
    if (cur.filePath && existsSync(cur.filePath)) {
      tickTail(cur);
    } else {
      discoveryTick();
    }
  }, POLL_INTERVAL_MS);
  // Initial discovery so we don't wait 1s for the first tick.
  discoveryTick();
}

export function stopOpencodeLogTail(): void {
  const s = getState();
  if (s?.timer) {
    clearInterval(s.timer);
  }
  setState(null);
}
