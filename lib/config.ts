// HARDENING_PLAN.md#C5 — typed env-var module.
//
// Pre-fix: 12 distinct env vars were read directly via process.env.X
// across 13 files, each with its own ?? '...' fallback inline. No
// single grep target for "what's configurable". Drift risk: rename
// an env var in one place, miss the others.
//
// Post-fix: every env-var read goes through this module. The exported
// constants carry the documented defaults + types. Future changes to
// configurable behavior happen in one place.
//
// Server-only — these constants reference process.env at module load
// and many are sensitive (basic auth credentials). Importing from a
// client component will cause Next.js to refuse the bundle thanks to
// `import 'server-only'`.

import 'server-only';

import path from 'node:path';

// Read with default. The defaults match the historical inline `??`
// values per env var so the migration is a no-op behaviorally.
function envStr(name: string, defaultValue: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? defaultValue : v;
}

function envOptional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : defaultValue;
}

// ----- opencode connection ------------------------------------------------

// Where opencode is reachable from this server. Default is the dev-
// server convention (port 4097, isolated from the ollama-swarm sibling
// app's 4096). Override for prod.
export const OPENCODE_URL = envStr('OPENCODE_URL', 'http://127.0.0.1:4097');

// Basic-auth credentials forwarded server-side; never shipped to the
// browser. Both must be set in production; in dev the defaults are
// fine for the Windows launcher's preconfigured auth.
export const OPENCODE_BASIC_USER = envOptional('OPENCODE_BASIC_USER');
export const OPENCODE_BASIC_PASS = envOptional('OPENCODE_BASIC_PASS');

// Where opencode writes its log files (used by F2 log tail to surface
// transport errors in dev). Default is the standard XDG-style path on
// Linux/WSL; on Windows the .ps1 launcher sets this explicitly.
export const OPENCODE_LOG_DIR = envOptional('OPENCODE_LOG_DIR');

// Shell command to restart opencode when the dev server detects a
// frozen instance. Used by the auto-restart watchdog (#7.Q26 lineage).
// Optional — auto-restart is opt-in.
export const OPENCODE_RESTART_CMD = envOptional('OPENCODE_RESTART_CMD');

// ----- ollama (provider for some models) ----------------------------------

// Where ollama is reachable. Used by the rate-limit probe + model
// prewarm. Default matches the standard ollama install.
export const OLLAMA_URL = envStr('OLLAMA_URL', 'http://127.0.0.1:11434');

// ----- swarm runtime data -------------------------------------------------

// Override via env for deployments that want runs under a different
// root (e.g. a mounted volume). Default is repo-root/.opencode_swarm.
export const OPENCODE_SWARM_ROOT = envStr(
  'OPENCODE_SWARM_ROOT',
  path.join(process.cwd(), '.opencode_swarm'),
);

// Heat-rail half-life seconds — how fast file-edit heat decays in the
// UI. Lower = more aggressive forgetting. Default 7200s = 2h.
export const OPENCODE_HEAT_HALF_LIFE_S = envInt(
  'OPENCODE_HEAT_HALF_LIFE_S',
  7200,
);

// ----- demo-log retention -------------------------------------------------

// Whether the startup pass should auto-delete old demo logs (vs only
// compress). Off by default — opt-in destructive operation.
export const DEMO_LOG_AUTO_DELETE = envBool('DEMO_LOG_AUTO_DELETE', false);

// Days to retain demo logs before deletion (when auto-delete is on).
// Default 30.
export const DEMO_LOG_RETENTION_DAYS = envInt('DEMO_LOG_RETENTION_DAYS', 30);

// ----- shell environment (informational — not configuration) -------------

// User running the process. Used by some path resolutions on WSL.
// Read-only; we never *set* USER. Captured here so future code that
// needs the username has one place to look.
export const USER = envOptional('USER');

// WSL-specific username override. On WSL2 the Linux $USER may differ
// from the Windows username; some opencode paths need the Windows one.
export const WSL_USER = envOptional('WSL_USER');
