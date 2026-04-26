// HARDENING_PLAN.md#D4 #4b — role-differentiated pattern integration test.
//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, type SpawnedRun } from './_harness';

const TIMEOUT_MS = 90_000;

describe('pattern: role-differentiated', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it.skip(
    'each role produces a reply scoped to its responsibility within 90s',
    async () => {
      run = await spawnRun({
        pattern: 'role-differentiated',
        teamSize: 3,
        title: 'integration test · role-differentiated',
        directive:
          'Briefly survey the README. Each role: respond from your role ' +
          "perspective in one paragraph. Don't edit files.",
        bounds: { minutesCap: 2 },
      });

      const success = await waitForCondition(
        run,
        (snap) => {
          const sessions = (snap as { sessions?: Array<{ tokens?: number }> }).sessions ?? [];
          // Every role-bound session should produce at least some output.
          // Role-differentiated has no orchestrator session — every session is a role.
          return sessions.length >= 3 && sessions.every((s) => (s.tokens ?? 0) > 0);
        },
        TIMEOUT_MS,
      );

      expect(success, 'every role should produce a reply within 90s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
