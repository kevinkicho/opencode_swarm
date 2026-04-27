//
// Per-call context object threaded through the 5-helper pipeline
// (pickClaim → dispatchPrompt → awaitTurn → runGateChecks → commitDone).
// Each helper either returns an early TickOutcome (skipped/stale) or
// extends the context with new fields the next phase needs.
//
// Pre-split, these were all locals in the 832-LOC tickCoordinatorImpl.
// Lifting them here makes the data flow legible at a glance: each
// helper's input/output shape lives in one place rather than scattered
// across declaration sites.

import 'server-only';

import type { BoardItem } from '../../../../blackboard/types';
import type { OpencodeMessage } from '../../../../opencode/types';
import type { SwarmRunMeta } from '../../../../swarm-run-types';

/** Output of pickClaim — a fully-claimed todo on a fresh idle session. */
export interface ClaimContext {
  meta: SwarmRunMeta;
  sessionID: string;
  todo: BoardItem;
  ownerAgentId: string;
  /**
   * SHA anchors for files the planner pre-declared via [files:...].
   * Null when the todo has no expectedFiles (legacy / unconstrained).
   * Used by runGateChecks's drift check at commit time.
   */
  claimAnchors: { path: string; sha: string }[] | null;
  /**
   * True when stigmergy heat shifted the picker's choice away from
   * what age-only ordering would have selected. Surfaced as a chip
   * on the board-rail row.
   */
  pickedByHeat: boolean;
}

/** Output of dispatchPrompt — the work prompt was posted to opencode. */
export interface DispatchedContext extends ClaimContext {
  /**
   * Snapshot of message IDs that existed BEFORE the work prompt was
   * posted. awaitTurn diffs against this to identify "new since
   * dispatch" messages.
   */
  knownIDs: Set<string>;
  /** Wall-clock deadline (Date.now() + timeoutMs) for awaitTurn. */
  deadline: number;
  /** The timeout that was used. Used in operator-facing error strings. */
  timeoutMs: number;
}

/** Output of awaitTurn — the assistant turn completed (ok=true path). */
export interface AwaitedContext extends DispatchedContext {
  messages: OpencodeMessage[];
  newIDs: Set<string>;
  /** Workspace-relative paths the worker actually edited (from patch parts). */
  editedPaths: string[];
}

/** Output of runGateChecks — every gate approved (or fail-open path taken). */
export interface GatedContext extends AwaitedContext {
  /**
   * SHA hashes of the workspace-relative paths the worker edited,
   * computed at commit time. May be empty when the worker produced
   * no patch (legitimate skip / research turn). Persisted on the
   * board row so the inspector / drift checks can correlate.
   */
  fileHashes: { path: string; sha: string }[];
}
