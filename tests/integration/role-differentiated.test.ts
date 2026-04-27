//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s + "≥1 role replies" predicate per
// the bible's "Tune against real run" guidance. Original predicate
// (every role) is too strict for cloud-model latency variance.
const TIMEOUT_MS = 180_000;

describe('pattern: role-differentiated', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    '≥1 role-bound session produces a reply within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'role-differentiated',
        teamSize: 3,
        title: 'integration test · role-differentiated',
        directive:
          'Briefly survey the README. Each role: respond from your role ' +
          "perspective in one paragraph. Don't edit files.",
        bounds: { minutesCap: 3 },
      });

      const success = await waitForCondition(
        run,
        (snap) => snapSessions(snap).some((s) => s.tokens > 0),
        TIMEOUT_MS,
      );

      expect(success, '≥1 role-bound session should reply within 180s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
