// Integration test harness. Shared between every per-pattern test in
// tests/integration/.
//
// Provides:
//   - spawnRun(opts): POST /api/swarm/run, returns the SpawnedRun handle
//   - waitForCondition(run, predicate, timeoutMs): polls /snapshot until
//     predicate returns true OR timeout (returns false)
//   - abortRun(run): POSTs /session/<id>/abort for each session;
//     fail-open
//
// Reads the dev server port from .dev-port (written by scripts/dev.mjs)
// — same source-of-truth our other scripts use. opencode talks via
// OPENCODE_SERVER_PASSWORD env var (or the user's persisted env).
//
// All HTTP calls use the `localhost` host explicitly because in WSL the
// 127.0.0.1 path can time out (per memory reference_dev_server_url.md);
// localhost resolves correctly.

import { readFileSync, existsSync } from 'node:fs';

export interface SpawnRequest {
  pattern: string;
  workspace?: string;
  directive: string;
  teamSize?: number;
  title?: string;
  bounds?: {
    minutesCap?: number;
    todosCap?: number;
    commitsCap?: number;
  };
}

export interface SpawnedRun {
  swarmRunID: string;
  sessionIDs: string[];
  port: number;
}

function devPort(): number {
  if (process.env.DEV_PORT) return Number(process.env.DEV_PORT);
  if (existsSync('.dev-port')) {
    const s = readFileSync('.dev-port', 'utf8').trim();
    const n = Number(s);
    if (Number.isInteger(n)) return n;
  }
  throw new Error(
    'integration harness: cannot resolve dev port — start `npm run dev` first or set DEV_PORT env',
  );
}

function workspace(): string {
  return (
    process.env.SWARM_TEST_WORKSPACE ||
    'C:\\Users\\kevin\\Workspace\\kyahoofinance032926'
  );
}

export async function spawnRun(opts: SpawnRequest): Promise<SpawnedRun> {
  const port = devPort();
  const body = {
    pattern: opts.pattern,
    workspace: opts.workspace ?? workspace(),
    directive: opts.directive,
    teamSize: opts.teamSize ?? 2,
    title: opts.title,
    bounds: opts.bounds,
  };
  const res = await fetch(`http://localhost:${port}/api/swarm/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `spawnRun: POST /api/swarm/run returned ${res.status}: ${await res.text()}`,
    );
  }
  const j = (await res.json()) as { swarmRunID: string; sessionIDs: string[] };
  return { swarmRunID: j.swarmRunID, sessionIDs: j.sessionIDs, port };
}

export async function snapshot(run: SpawnedRun): Promise<Record<string, unknown>> {
  const res = await fetch(
    `http://localhost:${run.port}/api/swarm/run/${run.swarmRunID}/snapshot`,
  );
  if (!res.ok) {
    throw new Error(`snapshot: GET returned ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

// Per-session shape from the /snapshot endpoint's `tokens.sessions[]`.
// IMPORTANT: snapshot session info lives at `tokens.sessions`, NOT at
// the top-level `sessions` field. Pre-2026-04-26 the integration tests
// read `(snap as any).sessions` and the predicate never matched —
// every test failed with "false" even when work had completed.
//
// This helper hides the path so test authors can't get it wrong again,
// and so a future shape change requires only one edit.
export interface SnapshotSession {
  sessionID: string;
  tokens: number;
  cost: number;
  lastActivityTs: number;
  /** Live-derived per-session status — 'idle' once the session has stopped emitting. */
  status: 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'done' | 'error';
  role?: string;
}

export function snapSessions(snap: Record<string, unknown>): SnapshotSession[] {
  const tokens = (snap as { tokens?: { sessions?: SnapshotSession[] } }).tokens;
  return tokens?.sessions ?? [];
}

/** True when every session shows status='idle' and the run has accumulated some tokens. */
function allSessionsIdleAfterWork(snap: Record<string, unknown>): boolean {
  const sessions = snapSessions(snap);
  if (sessions.length === 0) return false;
  const tokensTotal = (snap as { tokens?: { totals?: { tokens?: number } } }).tokens?.totals?.tokens ?? 0;
  if (tokensTotal === 0) return false;
  return sessions.every((s) => s.status === 'idle' || s.status === 'done');
}

/** True when the run-derived status is terminal — no further progress expected. */
function runStatusTerminal(snap: Record<string, unknown>): boolean {
  const status = (snap as { derivedRow?: { status?: string } }).derivedRow?.status
    ?? (snap as { status?: string }).status
    ?? '';
  return status === 'done' || status === 'stopped' || status === 'error' || status === 'stale';
}

// Poll the snapshot endpoint at ~3s cadence. Returns when:
//   1. predicate returns true (success), OR
//   2. the run has reached a no-more-progress state — every session
//      idle/done with tokens already accumulated, OR run-status terminal
//      — at which point we do ONE final predicate check and return its
//      result. This avoids waiting the full timeoutMs on a run that's
//      clearly finished its work but didn't trip the success criterion.
//   3. timeoutMs elapses (absolute upper bound).
//
// Tests assert on the boolean rather than throw, so the test failure
// reason is more informative.
export async function waitForCondition(
  run: SpawnedRun,
  predicate: (snap: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastSnap: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    try {
      const snap = await snapshot(run);
      lastSnap = snap;
      if (predicate(snap)) return true;
      // Short-circuit: run is done and won't produce more output. Final
      // check + bail. No point waiting another N polls.
      if (allSessionsIdleAfterWork(snap) || runStatusTerminal(snap)) {
        return predicate(snap);
      }
    } catch {
      // Transient — keep polling. The deadline still bounds it.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Final check on the last snap before declaring failure — a slow last
  // poll can leave the success state unobserved.
  if (lastSnap !== null && predicate(lastSnap)) return true;
  return false;
}

// Per-session message count — useful predicate for patterns that don't
// seed boards (council, debate-judge, critic-loop, map-reduce mappers).
// Returns the number of sessions whose `messages` array has at least
// `minMessages` entries.
export async function sessionsWithActivity(
  run: SpawnedRun,
  minMessages: number,
): Promise<number> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    throw new Error(
      'sessionsWithActivity: OPENCODE_SERVER_PASSWORD not set — cannot query opencode directly',
    );
  }
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  let count = 0;
  for (const sid of run.sessionIDs) {
    try {
      const res = await fetch(
        `http://172.24.32.1:4097/session/${sid}/message`,
        { headers: { Authorization: auth } },
      );
      if (!res.ok) continue;
      const ms = (await res.json()) as Array<unknown>;
      if (ms.length >= minMessages) count += 1;
    } catch {
      // Skip — counted as no activity.
    }
  }
  return count;
}

// Best-effort teardown. Aborts every session in the run. Failures
// don't fail the test — they only matter when sessions outlive the
// test process and burn tokens, and our F1 watchdog catches that
// independently.
export async function abortRun(run: SpawnedRun): Promise<void> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  await Promise.allSettled(
    run.sessionIDs.map((sid) =>
      fetch(`http://172.24.32.1:4097/session/${sid}/abort`, {
        method: 'POST',
        headers: { Authorization: auth },
      }),
    ),
  );
}
