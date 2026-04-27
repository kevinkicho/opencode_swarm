// HARDENING_PLAN.md#D4 #4e — council pattern integration test.
//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, type SpawnedRun } from './_harness';

const TIMEOUT_MS = 120_000;

describe('pattern: council', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  // 2026-04-26 attempt: harness works, test ran 150s before timing out.
  // The 120s predicate (every council member has tokens > 0) wasn't met
  // within the budget — opencode's cloud-model latency is variable, and
  // a council with teamSize=3 needs all 3 sessions to have produced
  // any output. Re-skipped pending criterion-tuning per the bible's
  // verification gate ("Tune the success criterion against a real run").
  it.skip(
    'completes ≥1 deliberation round within 120s',
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
        (snap) => {
          const sessions = (snap as { sessions?: Array<{ tokens?: number }> }).sessions ?? [];
          // All council members should produce a round-1 reply.
          return sessions.length >= 3 && sessions.every((s) => (s.tokens ?? 0) > 0);
        },
        TIMEOUT_MS,
      );

      expect(success, 'every council member should reply within 120s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
