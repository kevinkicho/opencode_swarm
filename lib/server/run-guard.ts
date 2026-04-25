// Shared entry/exit boilerplate for non-ticker orchestrator kickoffs.
//
// Every orchestrator in this directory (council, critic-loop, debate-judge,
// map-reduce) opens by reading meta + verifying it matches the expected
// pattern, and closes by calling finalizeRun in a finally block to abort
// any lingering in-flight session turns. That's ~20 lines of identical
// boilerplate × 4 sites = ~80 lines of mechanical duplication.
//
// withRunGuard centralizes the entry/exit shell so each orchestrator's
// body can focus on its actual state machine:
//
//   export async function runFooKickoff(swarmRunID: string): Promise<void> {
//     await withRunGuard(swarmRunID, { expectedPattern: 'foo', context: 'foo' }, async (meta) => {
//       if (meta.sessionIDs.length < 2) return;  // pattern-specific check
//       // ... orchestrator body ...
//     });
//   }
//
// Scope intentionally narrow: just the pattern-guard + finalize wrapping.
// The orchestrator body still owns its loop, its state-tracking
// (verdictHistory / drafts / etc.), and any partial-outcome recording.
// We don't try to abstract those because each orchestrator's state shape
// is genuinely different — see #82's design rationale.
//
// deliberate-execute does NOT use this helper because its lifecycle is
// a 3-phase composition (deliberation via runCouncilRounds + synthesis
// + execution via auto-ticker) where each phase owns its own cleanup.
// Wrapping the whole thing in finalizeRun would double-fire on phase
// transitions.

import { finalizeRun } from './finalize-run';
import { getRun } from './swarm-registry';
import type { SwarmRunMeta } from '../swarm-run-types';
import type { SwarmPattern } from '../swarm-types';

export interface RunGuardOpts {
  // Pattern(s) this orchestrator accepts. Most expect a single pattern;
  // council accepts both 'council' (standalone) and 'deliberate-execute'
  // (when called as that pattern's deliberation phase).
  expectedPattern: SwarmPattern | readonly SwarmPattern[];
  // Tag for log lines and the finalizeRun context. Examples: 'council',
  // 'critic-loop', 'debate-judge', 'map-reduce'.
  context: string;
}

export async function withRunGuard<T>(
  swarmRunID: string,
  opts: RunGuardOpts,
  body: (meta: SwarmRunMeta) => Promise<T | undefined>,
): Promise<T | undefined> {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(
      `[${opts.context}] run ${swarmRunID} not found — kickoff aborted`,
    );
    return undefined;
  }
  const expected = Array.isArray(opts.expectedPattern)
    ? (opts.expectedPattern as readonly SwarmPattern[])
    : [opts.expectedPattern as SwarmPattern];
  if (!expected.includes(meta.pattern)) {
    console.warn(
      `[${opts.context}] run ${swarmRunID} has pattern '${meta.pattern}', not ${expected.join(' | ')} — kickoff aborted`,
    );
    return undefined;
  }
  try {
    return await body(meta);
  } finally {
    await finalizeRun(swarmRunID, opts.context);
  }
}
