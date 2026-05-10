//
// Per-work-unit session isolation — the keystone of systematic Fix 1.
//
// When a worker claims a todo, this module replaces its opencode session
// with a fresh one so the agent's context window contains only the current
// work unit, never the history of prior work units.
//
// Steps:
//   1. Abort the old opencode session (idempotent — no-op if idle,
//      kills runaway token burn if a prior turn is stuck)
//   2. Create a fresh opencode session in the same workspace
//   3. Replace the session ID in meta.sessionIDs at the agent's index
//   4. Persist via updateRunMeta
//   5. Update the auto-ticker's PerSessionSlot from old → new session ID
//   6. Return the new session ID for the caller to dispatch to
//
// The old session is abandoned — preserved in the L0 event log for audit
// but never enters a future agent's context window.
//
// Same mechanism serves planner prompt caching: each re-sweep gets a
// fresh planner session, eliminating accumulated conversation history
// from prior sweeps (~60-70% of token waste).
//
// See docs/SYSTEMATIC_FIXES.md for the full design.

import 'server-only';

import {
  abortSessionServer,
  createSessionServer,
} from '../../../opencode-server';
import { getRun, updateRunMeta } from '../../../swarm-registry';
import { replaceTickerSession } from '../../auto-ticker/state';

export async function resetSessionForClaim(
  swarmRunID: string,
  oldSessionID: string,
  workspace: string,
): Promise<string> {
  // Step 1: Abort old session. Fire-and-forget, catch-all — we want the
  // session cleaned up but a slow abort must not block the claim.
  try {
    await abortSessionServer(oldSessionID, workspace);
  } catch (err) {
    // Soft abort may fail if opencode is unresponsive — log and continue.
    // The old session's in-flight turn (if any) will be cleaned up later
    // by the shutdown hook or startup orphan-cleanup when the run ends.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[claim-context] abort of old session ${oldSessionID.slice(-8)} failed (non-fatal): ${message}`,
    );
  }

  // Step 2: Create a fresh session in the same workspace.
  // opencode mints a new session with no prior conversation history.
  const session = await createSessionServer(workspace);

  // Step 3: Update persisted meta — replace old session ID at the same
  // index so teamModels[i] still maps to the correct agent.
  const meta = await getRun(swarmRunID);
  if (meta) {
    const idx = meta.sessionIDs.indexOf(oldSessionID);
    if (idx >= 0) {
      const newIDs = [...meta.sessionIDs];
      newIDs[idx] = session.id;
      await updateRunMeta(swarmRunID, { sessionIDs: newIDs });
    }
  }

  // Step 4: Update the auto-ticker's in-memory state so future ticks
  // dispatch to the new session ID instead of the old one.
  replaceTickerSession(swarmRunID, oldSessionID, session.id);

  return session.id;
}
