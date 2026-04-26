// HARDENING_PLAN.md#D4 #4g — deliberate-execute pattern integration test.
//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, type SpawnedRun } from './_harness';

const TIMEOUT_MS = 150_000;

describe('pattern: deliberate-execute', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it.skip(
    'completes deliberation phase, synthesis, and ≥1 execute within 150s',
    async () => {
      run = await spawnRun({
        pattern: 'deliberate-execute',
        teamSize: 3, // 2 deliberators + 1 executor (executor reuses session[1])
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
          const board = (snap as { board?: { items?: Array<{ kind: string; status: string }> } }).board;
          const items = board?.items ?? [];
          return items.some((i) => i.status === 'done' || /finding|synthesis/i.test(i.kind));
        },
        TIMEOUT_MS,
      );

      expect(success, 'deliberate-execute should complete a phase within 150s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
