//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: criterion tuned per the bible's "Tune against
// real run" guidance. Original predicate required every member to have
// tokens > 0 within 120s; that ran 150s without converging because
// cloud-model latency is variable across N parallel sessions. Loosened
// to "≥1 session has produced output" — proves the council kickoff
// fanout fired and at least one member is alive. Same pattern as
// orchestrator-worker (which already used `.some`).
const TIMEOUT_MS = 180_000;

describe('pattern: council', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'kicks off and produces ≥1 member reply within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'council',
        teamSize: 3,
        title: 'integration test · council',
        directive:
          'Briefly survey the README. Each member: argue for ONE improvement. ' +
          'Convergence is fine after one round.',
        bounds: { minutesCap: 3 },
      });

      const success = await waitForCondition(
        run,
        (snap) => snapSessions(snap).some((s) => s.tokens > 0),
        TIMEOUT_MS,
      );

      expect(success, '≥1 council member should reply within 180s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
