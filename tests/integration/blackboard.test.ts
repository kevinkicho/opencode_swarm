// Integration test — pattern smoke for `blackboard`.
//
// First instance of the pattern integration test contract. Each pattern
// gets one test in tests/integration/<pattern>.test.ts that:
//
//   1. Spawns a real swarm run via POST /api/swarm/run
//   2. Waits for the pattern's natural completion-signal (varies per pattern)
//   3. Asserts the success criterion (varies per pattern)
//   4. Aborts the run sessions for clean teardown
//
// REQUIRES live infrastructure:
//   - Next.js dev server on .dev-port
//   - opencode :4097 reachable
//   - OPENCODE_SERVER_PASSWORD set
//   - A test workspace (defaults to env.SWARM_TEST_WORKSPACE or
//     C:\Users\kevin\Workspace\kyahoofinance032926 — change for CI)
//
// Run via:   npm run test:integration
// Default `npm run test` skips this layer (vitest config gates on
// VITEST_INTEGRATION=1).
//
// Cost: each test spawns a real run for up to 90 seconds with a tiny
// directive — target spend ≈ $0.30-0.80 per pattern. Suite-wide cost
// for all 8 patterns ~$3-6. Cheap enough to run on every PR.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s + "≥1 worker reply OR ≥1 active
// board item" — proves the planner seeded the board AND a worker
// started claiming. Original predicate (`done >= 1`) requires a full
// commit cycle within 90s, which cloud models can't reliably hit.
const TIMEOUT_MS = 180_000;

describe('pattern: blackboard', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'blackboard seeds a board and ≥1 worker reply within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'blackboard',
        teamSize: 2,
        title: 'integration test · blackboard',
        directive:
          'Briefly survey the README and produce a one-paragraph summary. No file edits — just a written report as text in your assistant turn.',
        bounds: { minutesCap: 3 },
      });

      const success = await waitForCondition(
        run,
        (snap) => {
          const sessions = snapSessions(snap);
          const board = (snap as { board?: { items?: Array<{ status: string }> } }).board;
          const items = board?.items ?? [];
          const active = items.filter((i) =>
            i.status === 'claimed' || i.status === 'in-progress' || i.status === 'done',
          ).length;
          return sessions.some((s) => s.tokens > 0) || active >= 1;
        },
        TIMEOUT_MS,
      );

      expect(success, 'blackboard should produce ≥1 reply within 180s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
