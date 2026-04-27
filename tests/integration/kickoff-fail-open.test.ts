//
// Today: when the per-pattern orchestrator throws on its first await
// (bad model name, opencode unreachable, planner-prompt build error),
// the route catches via .catch((err) => console.warn(...)) and returns
// 201 with a swarmRunID. The user gets a "run created" response and
// the run sits as a zombie forever.
//
// After R1: synchronous throws within 150ms surface as 5xx with
// { error: 'kickoff-failed', detail: <message> } and the run is marked
// status=error in the registry instead of staying live.
//
// Scaffold for now — un-skip after R1 ships.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnRun, abortRun, type SpawnedRun } from './_harness';

describe('R1 · kickoff fail-open does not return 201 (to be implemented)', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it.skip(
    'returns 5xx when the orchestrator throws synchronously',
    async () => {
      // Trigger a synchronous failure path. Easiest reproducer is an
      // invalid model identifier — the orchestrator's first attempt
      // to dispatch will throw inside opencode-server's auth/model
      // resolution.
      //
      // Equivalent recipe (once R1 ships):
      //
      //   const res = await fetch(`http://localhost:${port}/api/swarm/run`, {
      //     method: 'POST',
      //     headers: { 'content-type': 'application/json' },
      //     body: JSON.stringify({
      //       pattern: 'critic-loop',
      //       workspace: '/tmp/no-such-workspace',
      //       directive: 'reproduce-r1',
      //       teamSize: 2,
      //       teamModels: ['definitely-not-a-real-model:cloud', 'glm-5.1:cloud'],
      //     }),
      //   });
      //   expect(res.status).toBeGreaterThanOrEqual(500);
      //   const body = await res.json();
      //   expect(body.error).toBe('kickoff-failed');
      //   expect(body.detail).toBeTruthy();
      //
      //   // And the registry should NOT have a live run for this attempt.
      //   const runsRes = await fetch(`http://localhost:${port}/api/swarm/run`);
      //   const runs = await runsRes.json();
      //   const matches = runs.filter((r: { directive: string }) =>
      //     r.directive === 'reproduce-r1');
      //   for (const r of matches) {
      //     expect(r.status).not.toBe('live');
      //   }
    },
  );

  it.skip(
    'returns 201 + gateFailures when only the gate-session spawn fails',
    async () => {
      // R1 sub-fix: critic/verifier/auditor session spawn failures
      // should surface as a `gateFailures` field on the 201 body
      // instead of silently falling through to undefined session IDs.
      //
      //   expect(res.status).toBe(201);
      //   const body = await res.json();
      //   expect(body.gateFailures).toBeDefined();
      //   expect(body.gateFailures.critic).toBeTruthy();
    },
  );
});
