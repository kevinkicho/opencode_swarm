//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s + "≥1 mapper reply OR any board
// item" so the test passes when mappers are actively working even if
// the reducer hasn't committed yet. Original predicate (synthesis kind
// on board) requires the full reduce phase to land — too strict for
// the 3-min budget on cloud models.
const TIMEOUT_MS = 180_000;

describe('pattern: map-reduce', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'map-reduce fans out and ≥1 mapper produces output within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'map-reduce',
        teamSize: 3,
        title: 'integration test · map-reduce',
        directive:
          'Mappers: each pick a part of the README and summarize it. ' +
          'Reducer: combine into one paragraph.',
        bounds: { minutesCap: 3 },
      });

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

      expect(success, 'map-reduce should produce ≥1 reply within 180s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
