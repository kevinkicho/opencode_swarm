//
// Promised by 2026-04-25 postmortem F3. Status: scaffold (it.skip) until
// success criterion is validated against a real run. Mirror the
// blackboard.test.ts shape — spawn → wait for the natural completion
// signal → assert.
//
// Un-skip when:
//   1. The dev server + opencode :4097 are reachable via the harness.
//   2. A 60-90s real run with the directive below has been observed
//      to reach the success condition reliably.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s per cloud-model latency slack.
const TIMEOUT_MS = 180_000;

describe('pattern: orchestrator-worker', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'orchestrator delegates to workers and gathers ≥1 worker reply within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'orchestrator-worker',
        teamSize: 3, // 1 orchestrator + 2 workers (orchestrator on session[0])
        title: 'integration test · orchestrator-worker',
        directive:
          'Read the README briefly, then split into two small subtasks ' +
          'and have workers each report back with a one-line finding.',
        bounds: { minutesCap: 2 },
      });

      // Success: at least one worker session has produced tokens.
      // Worker sessions = everything but session[0] (the orchestrator).
      const success = await waitForCondition(
        run,
        (snap) => {
          const sessions = snapSessions(snap);
          const workers = sessions.slice(1);
          return workers.some((s) => s.tokens > 0);
        },
        TIMEOUT_MS,
      );

      expect(success, 'orchestrator-worker should produce ≥1 worker reply within 90s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
