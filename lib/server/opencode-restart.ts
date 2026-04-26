// Opt-in opencode auto-restart helper.
//
// When the frozen-watchdog in `auto-ticker.ts` declares a run
// `opencode-frozen` (tokens stuck for ≥ 10 min with no recent Zen 429
// in the log), this module runs the shell command in OPENCODE_RESTART_CMD
// as a side effect. Kept opt-in because:
//   - we can't test every user's launcher without executing it
//   - zero-config behavior must be unchanged (pre-existing runs don't
//     suddenly spawn surprise processes)
//   - opencode on Windows vs Linux vs WSL host wants different commands
//
// Module-level debounce prevents restart hammering when opencode comes
// back broken — if the previous attempt is < RESTART_DEBOUNCE_MS old,
// we skip the new attempt and log why. The watchdog still fires its
// 15-min STARTUP_GRACE when the ticker restarts, so a stuck-restart
// loop self-bounds at ~2 attempts per hour.
//
// Not called from the route layer — only the watchdog consumes this.

import 'server-only';

import { spawn } from 'node:child_process';
import { OPENCODE_RESTART_CMD } from '../config';

// 10 min: long enough that the STARTUP_GRACE (15 min) has clearly
// elapsed since the last attempt, short enough that a genuinely-flaky
// restart gets a second shot within a reasonable window.
const RESTART_DEBOUNCE_MS = 10 * 60 * 1000;

interface RestartState {
  lastAttemptAtMs: number;
  lastOutcome?: 'spawned' | 'spawn-failed' | 'disabled' | 'debounced';
}

// Module-level state — one restart counter per Next.js process. HMR
// survives because this module is imported once and its state map lives
// on globalThis like the other singletons in `lib/server/`.
const G_KEY = Symbol.for('opencode_swarm.opencode_restart');
type GlobalWithRestart = typeof globalThis & { [G_KEY]?: RestartState };
function state(): RestartState {
  const g = globalThis as GlobalWithRestart;
  if (!g[G_KEY]) g[G_KEY] = { lastAttemptAtMs: 0 };
  return g[G_KEY]!;
}

export interface RestartAttempt {
  outcome: 'spawned' | 'spawn-failed' | 'disabled' | 'debounced';
  command?: string;
  message?: string;
  debounceRemainingMs?: number;
}

// Attempt a restart. Fire-and-forget: the watchdog doesn't wait for
// opencode to come back, it just logs that the attempt happened.
// Returns synchronously — spawn() is non-blocking and the child is
// detached so Node can exit without waiting on it.
export function maybeRestartOpencode(context: string): RestartAttempt {
  const s = state();
  const cmd = OPENCODE_RESTART_CMD?.trim();
  if (!cmd) {
    // Zero-config path: unchanged behavior from before this helper existed.
    s.lastOutcome = 'disabled';
    return { outcome: 'disabled' };
  }

  const now = Date.now();
  const sinceLast = now - s.lastAttemptAtMs;
  if (s.lastAttemptAtMs > 0 && sinceLast < RESTART_DEBOUNCE_MS) {
    const remaining = RESTART_DEBOUNCE_MS - sinceLast;
    s.lastOutcome = 'debounced';
    console.warn(
      `[opencode-restart] ${context}: skipped — last attempt ${Math.round(sinceLast / 60_000)}min ago, debounce window ${Math.round(remaining / 60_000)}min remaining`,
    );
    return { outcome: 'debounced', debounceRemainingMs: remaining };
  }

  try {
    // shell:true so $PATH / powershell / .ps1 / .bat all work without
    // the user having to tokenize their own command. detached:true +
    // stdio:'ignore' + unref() so Node can exit (SIGTERM shutdown path)
    // without waiting on the child. The child's own lifecycle is the
    // launcher's problem — we just fire it.
    const child = spawn(cmd, [], {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    child.on('error', (err) => {
      console.warn(
        `[opencode-restart] ${context}: spawn error — ${err.message}`,
      );
    });
    s.lastAttemptAtMs = now;
    s.lastOutcome = 'spawned';
    console.warn(
      `[opencode-restart] ${context}: executed OPENCODE_RESTART_CMD — opencode should self-restart. Ticker will stay stopped until the user POSTs start.`,
    );
    return { outcome: 'spawned', command: cmd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    s.lastOutcome = 'spawn-failed';
    console.warn(
      `[opencode-restart] ${context}: spawn failed — ${message}`,
    );
    return { outcome: 'spawn-failed', message };
  }
}

// Introspection helper for future UI surfacing ("last restart attempt
// 3m ago"). Not consumed today — exported so downstream code can read
// the counter without guessing at the Symbol key.
export function lastRestartAttempt(): RestartState {
  return { ...state() };
}
