// Permanent dev port: 8044 (frontend + API routes — Next.js is one server).
// Opencode backend stays at 4097 (per .env / OPENCODE_URL); only the
// Next.js dev port is managed here.
//
// 2026-04-28: switched from rolled-once-then-pinned ephemeral ports to
// a fixed 8044 because the rolling URL was making it hard to keep one
// bookmark and one mental model across sessions. If 8044 is taken on
// startup, the script kills whatever's holding it and claims the port
// — same intent as before (always reach the same URL) but with a
// memorable address. Override one-shot via DEV_PORT=xxxx.
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const SKIP_TSC = args.includes('--skip-tsc') || process.env.DEV_SKIP_TSC === '1';
// Opt into turbopack's beta dev compiler. Measured 2026-04-27: ~13%
// faster cold compile on this codebase (25s vs 29s for / on a fresh
// .next). Off by default until turbopack is GA stable.
const TURBO = args.includes('--turbo') || process.env.DEV_TURBO === '1';

// Permanent port. 8044 is outside well-known ranges and outside our
// previous ephemeral roll range (49152-65535) so old bookmarks can't
// silently land on a stale random port. .dev-port is still written
// for back-compat with scripts/_verify-*.mjs that read it.
const DEFAULT_PORT = 8044;
const PORT_FILE = '.dev-port';

const isFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });

// Kill whatever is holding `port`. Uses lsof to find PIDs (works on
// Linux + WSL); falls back silently if lsof is missing. Sends SIGKILL
// because we want the port unconditionally — graceful shutdown is the
// holder's problem, not ours.
function killHolders(port) {
  const r = spawnSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout) return [];
  const pids = r.stdout
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* race: died already */
    }
  }
  // 500ms grace then SIGKILL holdouts.
  spawnSync('sleep', ['0.5']);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  return pids;
}

async function resolvePort() {
  const requested = process.env.DEV_PORT
    ? Number(process.env.DEV_PORT)
    : DEFAULT_PORT;
  if (await isFree(requested)) return requested;
  // Port held by another process — tell the user what we're killing,
  // do it, wait for the port to free up, then claim. If it's still
  // busy after 2s give up.
  console.log(`[dev] port ${requested} is busy — killing holders`);
  const killed = killHolders(requested);
  if (killed.length) console.log(`[dev]   killed pids: ${killed.join(', ')}`);
  for (let i = 0; i < 10; i += 1) {
    spawnSync('sleep', ['0.2']);
    if (await isFree(requested)) return requested;
  }
  throw new Error(
    `[dev] port ${requested} still busy after kill — see lsof -i:${requested}`,
  );
}

// Pre-flight: better-sqlite3's native binding is platform-specific. If the
// last `npm install` / `npm rebuild` ran on a different platform than this
// one (e.g. installed on Windows, now starting dev from WSL), the require
// throws ERR_DLOPEN_FAILED *inside* the blackboard DB path — which is only
// hit once a swarm run spawns, so the failure surfaces minutes later as a
// silently-dead planner sweep. Check up front.
function preflightNativeModules() {
  const require = createRequire(import.meta.url);
  try {
    require('better-sqlite3');
  } catch (err) {
    const code = err && err.code;
    if (code === 'MODULE_NOT_FOUND') {
      console.error(
        '\n[dev] better-sqlite3 is not installed. Run `npm install` first.\n',
      );
    } else if (code === 'ERR_DLOPEN_FAILED') {
      console.error(
        '\n[dev] better-sqlite3 native binding is built for a different platform\n' +
          `      (process.platform=${process.platform}, process.arch=${process.arch}).\n` +
          '      Fix: `npm rebuild better-sqlite3`\n' +
          '      Note: rebuilding in one environment breaks the other — WSL and\n' +
          '      Windows each need their own rebuild after switching sides.\n',
      );
    } else {
      console.error(`\n[dev] better-sqlite3 preflight failed: ${err.message}\n`);
    }
    process.exit(1);
  }
}
preflightNativeModules();

// 2026-04-26 #102 — typecheck gate. Catches parallel-session breakages
// BEFORE we bind the port. Skip via `npm run dev -- --skip-tsc` or
// DEV_SKIP_TSC=1 when you genuinely need to start dev with broken code.
function preflightTypecheck() {
  if (SKIP_TSC) {
    console.log('[dev] tsc gate skipped (--skip-tsc / DEV_SKIP_TSC=1)');
    return;
  }
  console.log('[dev] tsc --noEmit gate (use --skip-tsc to bypass) …');
  const t0 = Date.now();
  const result = spawnSync('npx', ['tsc', '--noEmit'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: true,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`[dev] tsc gate passed in ${elapsed}s`);
    return;
  }
  console.error(`\n[dev] tsc gate FAILED in ${elapsed}s — refusing to start.`);
  console.error('      Fix the errors below, or pass --skip-tsc to start anyway:\n');
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}
preflightTypecheck();

const port = await resolvePort();
writeFileSync(PORT_FILE, String(port));
console.log(`\n[dev] using port ${port} (permanent — DEV_PORT=xxxx for one-shots)\n`);

// WSL mounts (/mnt/c/...) don't deliver inotify events reliably, so
// Next's default native file-watcher misses edits made by WSL-side
// tools. WATCHPACK_POLLING + CHOKIDAR_USEPOLLING force polling.
const devEnv = {
  ...process.env,
  WATCHPACK_POLLING: 'true',
  CHOKIDAR_USEPOLLING: 'true',
  CHOKIDAR_INTERVAL: '300',
};

const nextArgs = ['dev', '-p', String(port)];
if (TURBO) nextArgs.push('--turbo');
const child = spawn('next', nextArgs, {
  stdio: 'inherit',
  shell: true,
  env: devEnv,
  detached: true,
});

function killGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      if (!child.killed) child.kill(signal);
    } catch {
      /* both paths failed — nothing more we can do */
    }
  }
}

let shutdownInFlight = false;
function shutdown(signal) {
  if (shutdownInFlight) return;
  shutdownInFlight = true;
  killGroup(signal);
  setTimeout(() => {
    console.log(`\n[dev] shutdown timeout — forcing exit after ${signal}`);
    process.exit(128 + (signalNumber(signal) ?? 15));
  }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

if (
  process.stdin &&
  typeof process.stdin.on === 'function' &&
  process.stdin.isTTY
) {
  process.stdin.on('end', () => {
    console.log('\n[dev] tty stdin closed (Ctrl+D) — tearing down child group');
    killGroup('SIGTERM');
    setTimeout(() => {
      killGroup('SIGKILL');
      process.exit(143);
    }, 1500);
  });
  try {
    process.stdin.resume();
  } catch {
    /* some terminals don't allow resume */
  }
}

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`\n[dev] child exited via ${signal}`);
    process.exit(128 + (signalNumber(signal) ?? 15));
  }
  process.exit(code ?? 0);
});

function signalNumber(signal) {
  switch (signal) {
    case 'SIGINT':
      return 2;
    case 'SIGTERM':
      return 15;
    case 'SIGHUP':
      return 1;
    default:
      return null;
  }
}
