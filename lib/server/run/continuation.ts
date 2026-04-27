//
// Continuation inheritance: when req.continuationOf is set, look up the
// prior run and fill in fields the new run should inherit (workspace,
// source). Also returns the ambition-ratchet tier to start at — the new
// run's first planner sweep picks up where the prior run left off, so a
// pattern switch mid-project doesn't reset ambition to tier 1.
//
// Rejections return a 400-ready error string. Success mutates `req` in
// place (fills workspace + source when they were blank) and returns the
// starting tier (≥ 1).

import 'server-only';

import { getRun } from '../swarm-registry';
import type { SwarmRunRequest } from '../../swarm-run-types';

export async function resolveContinuation(
  req: SwarmRunRequest,
): Promise<number | string> {
  if (!req.continuationOf) return 1;
  const prior = await getRun(req.continuationOf);
  if (!prior) {
    return `continuationOf: run '${req.continuationOf}' not found`;
  }
  if (!req.workspace) {
    req.workspace = prior.workspace;
  } else if (req.workspace !== prior.workspace) {
    return `continuationOf: workspace '${req.workspace}' does not match prior run's workspace '${prior.workspace}' — refusing silent fork`;
  }
  if (!req.source && prior.source) {
    req.source = prior.source;
  }
  // Tier clamp: prior.currentTier may have been set by a future
  // version with a different max. Clamp into [1, MAX_TIER_FLOOR=5]
  // here rather than letting a bogus value propagate into the planner
  // prompt. If the prior run exhausted tier 5 (tierExhausted), the new
  // run resumes at tier 5 — the planner will decide if there's still
  // tier-5 work to do.
  const priorTier = prior.currentTier ?? 1;
  return Math.max(1, Math.min(5, priorTier));
}
