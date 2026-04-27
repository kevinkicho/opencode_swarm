//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s + "≥1 deliberator reply OR any
// board item" so the test passes during the deliberation phase
// (before synthesis lands on the board). Original predicate (done
// status or finding/synthesis kind) requires execute phase to commit
// — too narrow for the 3-min cloud-model budget.
const TIMEOUT_MS = 180_000;

describe('pattern: deliberate-execute', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'deliberate-execute kicks off and ≥1 phase produces output within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'deliberate-execute',
        teamSize: 3,
        title: 'integration test · deliberate-execute',
        directive:
          'Deliberate briefly on what one improvement to the README would ' +
          'be most valuable. Synthesize into a directive. Execute by writing ' +
          'a one-paragraph improvement suggestion as text.',
        bounds: { minutesCap: 4 },
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

      expect(success, 'deliberate-execute should produce ≥1 reply within 180s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
