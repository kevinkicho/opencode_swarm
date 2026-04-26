// Coordinator types + HMR registry key.
//
// Extracted from coordinator.ts in #107 phase 1. Sibling modules in
// `coordinator/` import from here so the central types live in one
// place; the public surface re-exports happen back in coordinator.ts
// to keep external callers' import paths unchanged.

import type { OpencodeMessage } from '../../../opencode/types';

// Shared key for HMR-resilient consumer lookups (see lib/server/hmr-exports.ts).
// Export so consumers can import it alongside the types.
export const COORDINATOR_EXPORTS_KEY = Symbol.for(
  'opencode_swarm.coordinator.exports',
);

export interface CoordinatorExports {
  // Forward-declare typeof — actual definitions below; TS hoists function
  // types so the declaration order works out.
  tickCoordinator: (
    swarmRunID: string,
    opts?: {
      restrictToSessionID?: string;
      excludeSessionIDs?: readonly string[];
    },
  ) => Promise<TickOutcome>;
  waitForSessionIdle: (
    sessionID: string,
    workspace: string,
    knownIDs: Set<string>,
    deadline: number,
  ) =>
    Promise<
      | { ok: true; messages: OpencodeMessage[]; newIDs: Set<string> }
      | {
          ok: false;
          reason:
            | 'timeout'
            | 'error'
            | 'silent'
            | 'provider-unavailable'
            | 'tool-loop';
        }
    >;
}

export type TickOutcome =
  | { status: 'picked'; sessionID: string; itemID: string; editedPaths: string[] }
  | { status: 'stale'; sessionID: string; itemID: string; reason: string }
  | { status: 'skipped'; reason: string };

export interface TickOpts {
  timeoutMs?: number;
  // Restrict the session picker to a single sessionID. When set, the tick
  // uses that session if idle, or returns skipped otherwise — it does not
  // fall back to other sessions. The auto-ticker passes this to fan out
  // one tick per session in parallel; map-reduce synthesis omits it so
  // any idle session can claim the synthesize item.
  restrictToSessionID?: string;
  // Exclude these sessions from the dispatch picker. Used by the
  // orchestrator-worker pattern to keep the orchestrator (session 0)
  // focused on planning while only workers (sessions 1..N) claim todos.
  // Applied before restrictToSessionID — a session in both is excluded.
  excludeSessionIDs?: readonly string[];
}
