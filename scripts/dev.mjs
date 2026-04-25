// Sticky random port: pick once, reuse forever.
// First run rolls a random port in the ephemeral range and writes it to
// `.dev-port`; subsequent runs read that file. This stays off well-known
// ports (so nothing else on the box collides by convention) while keeping
// the URL identical across restarts, so a bookmarked tab keeps working.
// Delete `.dev-port` to reroll. Override with DEV_PORT=xxxx for one-shots.
import net from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PORT_FILE = '.dev-port';
const MIN = 49152;
const MAX = 65535;

const isFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });

async function rollPort() {
  for (let i = 0; i < 20; i++) {
    const candidate = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    if (await isFree(candidate)) return candidate;
  }
  throw new Error('could not find a free port after 20 tries');
}

async function resolvePort() {
  if (process.env.DEV_PORT) return Number(process.env.DEV_PORT);
  if (existsSync(PORT_FILE)) {
    const saved = Number(readFileSync(PORT_FILE, 'utf8').trim());
    if (Number.isInteger(saved) && saved >= MIN && saved <= MAX && (await isFree(saved))) {
      return saved;
    }
  }
  const picked = await rollPort();
  writeFileSync(PORT_FILE, String(picked));
  return picked;
}

// Pre-flight: better-sqlite3's native binding is platform-specific. If the
// last `npm install` / `npm rebuild` ran on a different platform than this
// one (e.g. installed on Windows, now starting dev from WSL), the require
// throws ERR_DLOPEN_FAILED *inside* the blackboard DB path — which is only
// hit once a swarm run spawns, so the failure surfaces minutes later as a
// silently-dead planner sweep. Check up front and tell the user exactly
// what to run. Cost: one require on startup.
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

const port = await resolvePort();
console.log(`\n[dev] using port ${port} (from ${PORT_FILE} — delete to reroll)\n`);
// WSL mounts (/mnt/c/...) don't deliver inotify events reliably, so
// Next's default native file-watcher misses edits made by WSL-side
// tools. WATCHPACK_POLLING + CHOKIDAR_USEPOLLING force polling, which
// adds a small CPU cost but guarantees HMR picks up every change.
// Interval tuned at 300ms — fast enough to feel like HMR, slow enough
// not to thrash the CPU on a repo with thousands of node_modules files.
const devEnv = {
  ...process.env,
  WATCHPACK_POLLING: 'true',
  CHOKIDAR_USEPOLLING: 'true',
  CHOKIDAR_INTERVAL: '300',
};
// detached:true puts the child in a NEW process group, which lets us
// kill the entire group via `process.kill(-pid, signal)` — that
// reaches the shell child AND the next-server grandchild AND any
// further descendants. Without this (and especially with shell:true),
// killing only the shell can leave next-server orphaned, holding the
// dev port and blocking the next launch with EADDRINUSE. Observed
// repeatedly during 2026-04-24 multi-pattern testing where every
// teardown left a stale next-server (`pid 129224`, `pid 136965`) on
// the previously-used port until pkill cleaned up.
//
// stdio:'inherit' is preserved so the child's output still streams
// to our terminal — detached normally implies no parent stdio
// linkage, but explicit inherit keeps the dev server logs visible.
const child = spawn('next', ['dev', '-p', String(port)], {
  stdio: 'inherit',
  shell: true,
  env: devEnv,
  detached: true,
});

// Group-kill via process.kill(-pid, signal). The negative pid is the
// POSIX convention for "send to every process in this group" — only
// works because we set detached:true above. Wrapped in try/catch
// because the group may already be empty by the time we get here
// (e.g. natural exit before the signal arrived).
function killGroup(signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group already dead, or no permission — try the direct child kill
    // as a fallback so we still cover the normal-mode shutdown path.
    try {
      if (!child.killed) child.kill(signal);
    } catch {
      // Both paths failed — nothing more we can do.
    }
  }
}

// Forced-exit safety net for orphan diagnoses. Without this, if
// killGroup throws AND the child is already dead AND child.on('exit')
// never fires (because it already fired before we got here, or the
// child went into a zombie state), dev.mjs hangs forever holding the
// `node scripts/dev.mjs` pid in our task tracker. Observed multiple
// times during 2026-04-24 + 2026-04-25 sessions: next-server died
// but the wrapper persisted indefinitely.
//
// 5s grace gives killGroup time to land + child to exit naturally;
// after that we force-exit so the wrapper task always cleans up.
let shutdownInFlight = false;
function shutdown(signal) {
  if (shutdownInFlight) return; // double-signal — already in progress
  shutdownInFlight = true;
  killGroup(signal);
  setTimeout(() => {
    // child.on('exit') will have called process.exit by now if the
    // group-kill worked. If we're still here, the child is wedged —
    // force-exit so the wrapper-task tracker frees up.
    console.log(`\n[dev] shutdown timeout — forcing exit after ${signal}`);
    process.exit(128 + (signalNumber(signal) ?? 15));
  }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

// Stdin-EOF watchdog — gated on TTY. We previously listened for
// 'end' unconditionally to catch the parent-dies-without-forwarding-
// a-signal case, but in non-interactive contexts (npm script via
// pipe, background task via run_in_background, CI runners) stdin is
// already EOF on startup so the listener fired immediately and tore
// down a healthy server. Limiting the watch to TTY contexts
// (interactive terminals) keeps the orphan-detection where it
// matters (Ctrl+D / hangup cases) without breaking non-interactive
// invocations.
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
    // Some terminals don't allow resume — non-fatal.
  }
}

// Exit with the child's exit code so monitors (npm scripts, systemd,
// etc.) see the real outcome. If the child is killed by a signal we
// relay that as a non-zero exit.
child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`\n[dev] child exited via ${signal}`);
    process.exit(128 + (signalNumber(signal) ?? 15));
  }
  process.exit(code ?? 0);
});

function signalNumber(signal) {
  // Minimal POSIX lookup — enough for the signals we forward.
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
