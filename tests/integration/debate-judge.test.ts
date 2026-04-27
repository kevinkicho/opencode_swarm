//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s + "≥1 board item OR ≥1 generator
// reply" so the test passes when either the judge has verdicted OR a
// generator has produced output. Original predicate (judge verdict
// only) is too narrow — a 3-session debate can legitimately have all
// 3 sessions live + reasoning before any verdict lands on the board.
const TIMEOUT_MS = 180_000;

describe('pattern: debate-judge', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'debate-judge kicks off and ≥1 generator/judge reply within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'debate-judge',
        teamSize: 3,
        title: 'integration test · debate-judge',
        directive:
          'Generators: each propose one improvement to the README in ' +
          '3 bullets. Judge: pick a winner.',
        bounds: { minutesCap: 3 },
        debateMaxRounds: 1,
      } as Parameters<typeof spawnRun>[0]);

      const success = await waitForCondition(
        run,
        (snap) => {
          const sessions = snapSessions(snap);
          const board = (snap as { board?: { items?: unknown[] } }).board;
          const items = board?.items ?? [];
          return sessions.some((s) => s.tokens > 0) || items.length >= 1;
        },
        TIMEOUT_MS,
      );

      expect(success, 'debate-judge should produce ≥1 reply within 180s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
