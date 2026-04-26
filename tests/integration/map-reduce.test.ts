// HARDENING_PLAN.md#D4 #4f — map-reduce pattern integration test.
//
// Promised by 2026-04-25 postmortem F3. Scaffold until validated.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, waitForCondition, abortRun, type SpawnedRun } from './_harness';

const TIMEOUT_MS = 120_000;

describe('pattern: map-reduce', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it.skip(
    'fans out to mappers and produces a reduced synthesis within 120s',
    async () => {
      run = await spawnRun({
        pattern: 'map-reduce',
        teamSize: 3, // 2 mappers + 1 reducer
        title: 'integration test · map-reduce',
        directive:
          'Mappers: each pick a part of the README and summarize it. ' +
          'Reducer: combine into one paragraph.',
        bounds: { minutesCap: 3 },
      });

      const success = await waitForCondition(
        run,
        (snap) => {
          const board = (snap as { board?: { items?: Array<{ kind: string }> } }).board;
          const items = board?.items ?? [];
          // Synthesis row is the reducer's commit.
          return items.some((i) => /synthesis|reduce|finding/i.test(i.kind));
        },
        TIMEOUT_MS,
      );

      expect(success, 'map-reduce should produce a synthesis within 120s').toBe(true);
    },
    TIMEOUT_MS + 30_000,
  );
});
