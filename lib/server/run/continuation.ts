//
// Continuation inheritance: when req.continuationOf is set, look up the
// prior run and fill in fields the new run should inherit (workspace,
// source).
//
// Rejections return a 400-ready error string. Success mutates `req` in
// place (fills workspace + source when they were blank) and returns null.

import 'server-only';

import { getRun } from '../swarm-registry';
import type { SwarmRunRequest } from '../../swarm-run-types';

export async function resolveContinuation(
  req: SwarmRunRequest,
): Promise<string | null> {
  if (!req.continuationOf) return null;
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
  return null;
}
