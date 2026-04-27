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
// export async function runFooKickoff(swarmRunID: string): Promise<void> {
// await withRunGuard(swarmRunID, { expectedPattern: 'foo', context: 'foo' }, async (meta) => {
// if (meta.sessionIDs.length < 2) return; // pattern-specific check
// // ... orchestrator body ...
// });
// }
//
// Scope intentionally narrow: just the pattern-guard + finalize wrapping.
// The orchestrator body still owns its loop, its state-tracking
// (verdictHistory / drafts / etc.), and any partial-outcome recording.
// We don't try to abstract those because each orchestrator's state shape
// is genuinely different — see #82's design rationale.

import 'server-only';

import { finalizeRun } from './finalize-run';
import { getRun } from './swarm-registry';
import { recordPartialOutcome } from './degraded-completion';
import type { SwarmRunMeta } from '../swarm-run-types';
import type { SwarmPattern } from '../swarm-types';

export interface RunGuardOpts {
 // Pattern(s) this orchestrator accepts. Most expect a single pattern;
 // arrays allow accepting multiple (rare).
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
 } catch (err) {
 // #95 — fallback partial-outcome for any unhandled exception that
 // bubbles past the orchestrator's own recordPartialOutcome sites.
 // Without this, an opencode 5xx / network drop / unexpected
 // structural error inside the body just propagates to the route's
 // .catch() and lands a dev-log line; the run shows status=error
 // with NO finding row, which is exactly what bit debate-judge in
 // the MAXTEAM-2026-04-26 stress test (944K tokens, 0 findings,
 // status=error). Re-throwing preserves the existing route-level
 // logging — the partial-outcome record is purely additive.
 const message = err instanceof Error ? err.message : String(err);
 try {
 recordPartialOutcome(swarmRunID, {
 pattern: meta.pattern,
 phase: `${opts.context} (unhandled-exception)`,
 reason: message.slice(0, 80),
 summary: [
 `${opts.context} orchestrator threw an unhandled exception:`,
 '',
 message,
 '',
 'This finding is the fall-back from withRunGuard\'s catch path.',
 'The orchestrator\'s own recordPartialOutcome sites cover known',
 'failure shapes (timeout, silent, tool-loop, etc.); this row',
 'fires when something else broke (transport / 5xx / unexpected',
 'structural error in the body code path).',
 ].join('\n'),
 });
 } catch (recordErr) {
 // Recording the finding shouldn't itself trigger another error
 // path. If it does, log and continue — the original error must
 // still propagate to the caller.
 console.warn(
 `[${opts.context}] partial-outcome record failed during fallback:`,
 recordErr instanceof Error ? recordErr.message : String(recordErr),
 );
 }
 throw err;
 } finally {
 await finalizeRun(swarmRunID, opts.context);
 }
}
