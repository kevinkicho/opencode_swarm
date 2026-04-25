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

// Poll the snapshot endpoint at ~3s cadence until predicate returns
// true OR timeout. Returns whether the predicate succeeded. Tests
// assert on the boolean rather than throw, so the test failure
// reason is more informative.
export async function waitForCondition(
  run: SpawnedRun,
  predicate: (snap: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const snap = await snapshot(run);
      if (predicate(snap)) return true;
    } catch {
      // Transient — keep polling. The deadline still bounds it.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
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
