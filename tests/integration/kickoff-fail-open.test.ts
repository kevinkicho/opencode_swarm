// R1 — kickoff fail-open contract.
//
// Background: pre-R1, when the per-pattern orchestrator threw on its first
// await (bad model name, opencode unreachable, planner-prompt build error),
// the route caught the error and returned 201 with a swarmRunID anyway.
// The user got "run created" but the run sat as a zombie forever.
//
// Post-R1 (currently shipped — `app/api/swarm/run/route.ts:24-25`):
// synchronous throws within the 150ms guard window surface as 5xx with
// `{ error: 'kickoff-failed', detail: <message> }`. Sub-fix: gate-session
// (critic/verifier/auditor) spawn failures surface as `gateFailures` on
// the 201 body instead of silent undefined session IDs.
//
// These tests verify the contract still holds; they're regression backstops.

import { afterAll, describe, expect, it } from 'vitest';
import { abortRun, type SpawnedRun } from './_harness';
import { readFileSync, existsSync } from 'node:fs';

function devPort(): number {
  if (process.env.DEV_PORT) return Number(process.env.DEV_PORT);
  if (existsSync('.dev-port')) {
    const s = readFileSync('.dev-port', 'utf8').trim();
    const n = Number(s);
    if (Number.isInteger(n)) return n;
  }
  throw new Error('R1 test: cannot resolve dev port — start `npm run dev` first');
}

function workspace(): string {
  return (
    process.env.SWARM_TEST_WORKSPACE ||
    'C:\\Users\\kevin\\Workspace\\kyahoofinance032926'
  );
}

describe('R1 · kickoff fail-open contract', () => {
  let run: SpawnedRun | null = null;

  afterAll(async () => {
    if (run) await abortRun(run);
  });

  it('returns 5xx + kickoff-failed when the orchestrator throws synchronously', async () => {
    // Easiest synthetic reproducer: a `teamModels` entry naming a model that
    // doesn't exist in any provider. The kickoff's first dispatch attempt
    // throws inside opencode-server's model resolution well within the
    // 150ms guard window.
    const port = devPort();
    const res = await fetch(`http://localhost:${port}/api/swarm/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pattern: 'critic-loop',
        workspace: workspace(),
        directive: 'reproduce-r1',
        teamSize: 2,
        teamModels: [
          'definitely-not-a-real-model:cloud',
          'ollama/glm-5.1:cloud',
        ],
      }),
    });

    // Either 5xx with kickoff-failed (if dispatcher's model resolution rejects
    // synchronously), OR 4xx with a validation error if the route's pre-flight
    // catches the unknown model first. EITHER outcome is the contract: the
    // server must NOT 201-and-zombie. We assert "non-201" rather than strict
    // 5xx so a stricter pre-flight that rejects at validation still passes.
    expect(res.status).not.toBe(201);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const body = (await res.json()) as { error?: string; detail?: string };
    // Body shape: either `{ error: 'kickoff-failed', detail }` from the
    // 150ms guard, or `{ error: '...' }` from upstream validation. Both
    // are valid.
    expect(body.error).toBeTruthy();
  });

  it.skip(
    'returns 201 + gateFailures when only the gate-session spawn fails',
    async () => {
      // SKIP REASON: needs a fixture that makes ONE specific opencode
      // session-create call (the critic/verifier/auditor gate) fail
      // while the team session-creates succeed. opencode doesn't expose
      // a "fail the next call" hook, and a mock layer for opencodeFetch
      // hasn't been wired into the integration harness. Approaches:
      //
      //   (a) Wire a route-handler test layer that allows substituting
      //       createSessionServer with a Vitest fn that returns a
      //       rejecting Promise on Nth call.
      //   (b) Add an OPENCODE_DEV_FAIL_NTH=N env var that the proxy's
      //       opencodeFetch reads to reject the Nth call. Cheap to add,
      //       easy to expose only in NODE_ENV !== 'production'.
      //
      // Until either lands, this test stays skipped. The contract is
      // documented in app/api/swarm/run/route.ts step 7 ("best-effort;
      // failures surface in `gateFailures` on the 201") so a regression
      // would still be visible in the route's own typings + comments.
      //
      // When ready to wire it:
      //   expect(res.status).toBe(201);
      //   const body = await res.json();
      //   expect(body.gateFailures).toBeDefined();
      //   expect(body.gateFailures.critic).toBeTruthy();
    },
  );
});
