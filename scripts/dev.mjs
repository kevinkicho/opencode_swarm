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
const child = spawn('next', ['dev', '-p', String(port)], {
  stdio: 'inherit',
  shell: true,
  env: devEnv,
});

// Forward signals to the child so Ctrl+C, `kill <pid>`, or a parent
// process restart cleanly tears down next-dev and frees the listening
// port. Without this, `shell: true` can leave the grandchild running
// on the dev port, blocking the next launch with EADDRINUSE.
function forward(signal) {
  if (!child.killed) {
    try {
      child.kill(signal);
    } catch {
      // Child already dead — no-op.
    }
  }
}
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGHUP', () => forward('SIGHUP'));

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
