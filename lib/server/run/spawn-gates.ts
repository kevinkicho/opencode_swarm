// HARDENING_PLAN.md#C2 — app/api/swarm/run/route.ts split.
//
// Opt-in gate-session spawner. Three sessions can be requested:
//
//   - critic   (enableCriticGate)   — anti-busywork review per commit
//   - verifier (enableVerifierGate) — Playwright grounding for UX-claim todos
//   - auditor  (enableAuditorGate)  — contract-criterion verdicts
//
// Each is spawned best-effort. A failure accumulates into the returned
// `gateFailures` map and the run continues without that gate — degrades
// to "same as if the flag was off," which is a safer failure mode than
// blocking run creation on an opt-in feature.
//
// HARDENING_PLAN.md#R1 — gateFailures used to fall through to undefined
// silently; now they surface in the 201 response so the user has a
// signal that an enabled gate didn't actually come up.

import 'server-only';

import { createSessionServer } from '../opencode-server';
import type { SwarmRunRequest } from '../../swarm-run-types';

export interface SpawnedGates {
  criticSessionID?: string;
  verifierSessionID?: string;
  auditorSessionID?: string;
  failures: { critic?: string; verifier?: string; auditor?: string };
}

export async function spawnGateSessions(
  parsed: SwarmRunRequest,
  seedTitle: string | undefined,
): Promise<SpawnedGates> {
  const failures: SpawnedGates['failures'] = {};
  let criticSessionID: string | undefined;
  let verifierSessionID: string | undefined;
  let auditorSessionID: string | undefined;

  if (parsed.enableCriticGate) {
    try {
      const critic = await createSessionServer(
        parsed.workspace,
        seedTitle ? `${seedTitle} · critic` : undefined,
      );
      criticSessionID = critic.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        '[swarm/run] critic session spawn failed — run continues without critic gate:',
        message,
      );
      failures.critic = message;
    }
  }

  if (parsed.enableVerifierGate && parsed.workspaceDevUrl) {
    try {
      const verifier = await createSessionServer(
        parsed.workspace,
        seedTitle ? `${seedTitle} · verifier` : undefined,
      );
      verifierSessionID = verifier.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        '[swarm/run] verifier session spawn failed — run continues without verifier gate:',
        message,
      );
      failures.verifier = message;
    }
  }

  if (parsed.enableAuditorGate) {
    try {
      const auditor = await createSessionServer(
        parsed.workspace,
        seedTitle ? `${seedTitle} · auditor` : undefined,
      );
      auditorSessionID = auditor.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        '[swarm/run] auditor session spawn failed — run continues without auditor gate:',
        message,
      );
      failures.auditor = message;
    }
  }

  return { criticSessionID, verifierSessionID, auditorSessionID, failures };
}
