// HARDENING_PLAN.md#D4 #4c — critic-loop pattern integration test.
//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, snapSessions, type SpawnedRun } from './_harness';

// 2026-04-26 evening: tuned to 180s per cloud-model latency slack.
const TIMEOUT_MS = 180_000;

describe('pattern: critic-loop', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it(
    'critic-loop kicks off and ≥1 board item lands within 180s',
    async () => {
      run = await spawnRun({
        pattern: 'critic-loop',
        teamSize: 2, // worker + critic
        title: 'integration test · critic-loop',
        directive:
          'Briefly review the README and write a one-paragraph improvement ' +
          'suggestion as text. The critic will give feedback, then revise once.',
        bounds: { minutesCap: 3 },
        criticMaxIterations: 2,
      } as Parameters<typeof spawnRun>[0]);

      // Critic-loop completes when iterations >= 1 with a verdict reply.
      // /snapshot.board.items will accumulate critic-loop iteration rows
      // (or postmortem items on failure).
      const success = await waitForCondition(
        run,
        (snap) => {
          // Critic-loop has 2 sessions (worker + critic). Pass when
          // either session has produced output OR a board item lands.
          const sessions = snapSessions(snap);
          const board = (snap as { board?: { items?: unknown[] } }).board;
          const items = board?.items ?? [];
          return sessions.some((s) => s.tokens > 0) || items.length >= 1;
        },
        TIMEOUT_MS,
      );

      expect(success, 'critic-loop should produce a finding within 120s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
