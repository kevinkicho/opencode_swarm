// HARDENING_PLAN.md#D4 #4d — debate-judge pattern integration test.
//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, type SpawnedRun } from './_harness';

const TIMEOUT_MS = 120_000;

describe('pattern: debate-judge', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it.skip(
    'judge issues ≥1 verdict on generators within 120s',
    async () => {
      run = await spawnRun({
        pattern: 'debate-judge',
        teamSize: 3, // 2 generators + 1 judge
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
          const board = (snap as { board?: { items?: Array<{ kind: string }> } }).board;
          const items = board?.items ?? [];
          // Verdict items are the judge's output.
          return items.some((i) => /verdict|judge|finding/i.test(i.kind));
        },
        TIMEOUT_MS,
      );

      expect(success, 'debate-judge should issue ≥1 verdict within 120s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
