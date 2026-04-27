// Resolve a SwarmComposer target into the concrete list of opencode
// session IDs to POST to.
//
// Extracted from app/page.tsx (#174) so the fan-out contract is unit-
// testable. Before extraction, the broadcast branch silently regressed
// once — the original implementation routed broadcast to a single
// "primary" session, which on multi-session patterns dropped the
// message for every worker except the lead. The Set-of-sessionIDs
// approach below is the fix; this module's tests pin it.
//
// Pure / synchronous: no fetch, no side effects. Wiring to safePost
// happens at the call site so tests can assert on POST count without
// mocking fetch.

import type { Agent } from '@/lib/swarm-types';
import type { ComposerTarget } from '@/components/swarm-composer';

/**
 * Returns the distinct list of opencode sessionIDs that should receive
 * the composer body for the given target.
 *
 * - `kind: 'broadcast'` → every agent's sessionID, deduped (a roster
 *   where two agents share a session yields one POST, not two).
 * - `kind: 'agent'` → the target agent's sessionID, falling back to
 *   `fallbackSessionID` if the agent is unbound or not in the roster.
 *
 * Agents without a sessionID (pre-bind) are skipped from broadcast.
 */
export function resolveSendTargets(
  target: ComposerTarget,
  agents: Agent[],
  fallbackSessionID: string,
): string[] {
  if (target.kind === 'broadcast') {
    const sessionIDs = new Set<string>();
    for (const a of agents) {
      if (a.sessionID) sessionIDs.add(a.sessionID);
    }
    return [...sessionIDs];
  }
  const targetAgent = agents.find((a) => a.id === target.id);
  return [targetAgent?.sessionID ?? fallbackSessionID];
}
