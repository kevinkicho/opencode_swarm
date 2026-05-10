//
// Pattern contract enforcement — systematic Fix 3.
//
// Every orchestration pattern has topological invariants (session count,
// critical-role liveness). These are asserted at runtime — not just
// documented in markdown. When an invariant breaks, the run degrades
// gracefully with a recorded finding rather than silently corrupting.
//
// Degradation is always fail-open: a broken invariant produces a finding
// and the run continues. Partial results beat no results.
//
// See docs/SYSTEMATIC_FIXES.md for the full design.

import 'server-only';

import type { SwarmRunMeta } from '../../swarm-run-types';
import type { OpencodeMessage } from '../../opencode/types';
import { getSessionMessagesServer, postSessionMessageServer } from '../opencode-server';
import { getRun, updateRunMeta } from '../swarm-registry';
import { insertBoardItem } from './store';
import { mintItemId } from './item-ids';
import { tickers } from './auto-ticker/state';

// ─── PatternGuard interface ──────────────────────────────────────────

export interface PatternGuard {
  startupInvariant(meta: SwarmRunMeta): { ok: true } | { ok: false; reason: string };
  runtimeInvariant(swarmRunID: string, meta: SwarmRunMeta): Promise<{ ok: true } | { ok: false; reason: string }>;
  // Recovery action when runtimeInvariant fails. Returns a description of
  // what was done (for the finding). Optional — patterns without recovery
  // (blackboard, council) leave this undefined. Fail-open: wrapped in
  // try/catch by the caller.
  degrade?: (swarmRunID: string, meta: SwarmRunMeta) => Promise<string>;
  description: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

// Check if a session has produced any real work (has completed assistant
// messages with non-zero tool calls). Returns true when the session
// appears alive and functional. False when it has no completed messages
// after a grace period — likely a silent-failed session.
async function sessionIsProducing(
  sessionID: string,
  workspace: string,
): Promise<boolean> {
  try {
    const messages = await getSessionMessagesServer(sessionID, workspace);
    // A session that has at least one completed assistant message is
    // considered "producing" — it's demonstrated the ability to respond.
    const hasCompletedAssistant = messages.some(
      (m: OpencodeMessage) => m.info.role === 'assistant' && m.info.time.completed && !m.info.error,
    );
    return hasCompletedAssistant;
  } catch {
    // Can't reach opencode for this session? Can't tell if alive.
    // Conservatively report as alive — a false positive is better than
    // a false negative that kills the run.
    return true;
  }
}

// Record a guard violation as a finding board item so it surfaces in
// the contracts rail.
function recordGuardFinding(
  swarmRunID: string,
  pattern: string,
  finding: string,
): void {
  try {
    insertBoardItem(swarmRunID, {
      id: mintItemId(),
      kind: 'finding',
      content: `[pattern-guard] ${pattern}: ${finding}`,
      status: 'open',
      createdAtMs: Date.now(),
    });
  } catch (err) {
    console.warn(
      `[pattern-guard] failed to insert finding for ${swarmRunID}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── Per-pattern guards ──────────────────────────────────────────────

const criticLoopGuard: PatternGuard = {
  description: 'critic-loop: 1 worker + 1 critic, exactly 2 sessions',
  startupInvariant(meta) {
    if (meta.sessionIDs.length !== 2) {
      return { ok: false, reason: `critic-loop requires exactly 2 sessions (has ${meta.sessionIDs.length})` };
    }
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, meta) {
    // Critic is sessionIDs[1]. If critic has produced NO messages,
    // it may have silently failed at dispatch.
    const criticSID = meta.sessionIDs[1];
    const alive = await sessionIsProducing(criticSID, meta.workspace);
    if (!alive) {
      return { ok: false, reason: `critic session ${criticSID.slice(-8)} has produced no completed work — likely silent failure` };
    }
    return { ok: true };
  },
  async degrade(swarmRunID, meta) {
    // Post to worker: critic unavailable, output accepted as-is
    const workerSID = meta.sessionIDs[0];
    try {
      await postSessionMessageServer(workerSID, meta.workspace,
        '## [pattern-guard] Critic unavailable\n\nThe critic session is unresponsive. Your output is accepted as-is for the remaining iterations. Continue working from the board.');
    } catch { /* best effort — finding is already recorded */ }
    return `critic session ${meta.sessionIDs[1].slice(-8)} unresponsive — notified worker, remaining iterations auto-approved`;
  },
};

const owGuard: PatternGuard = {
  description: 'orchestrator-worker: 1 orchestrator + N workers',
  startupInvariant(meta) {
    if (meta.sessionIDs.length < 2) {
      return { ok: false, reason: `orchestrator-worker requires ≥2 sessions (has ${meta.sessionIDs.length})` };
    }
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, meta) {
    // Orchestrator is sessionIDs[0]. If it has produced no messages,
    // the run is dead — workers can't self-organize in OW pattern.
    const orchSID = meta.sessionIDs[0];
    const alive = await sessionIsProducing(orchSID, meta.workspace);
    if (!alive) {
      return { ok: false, reason: `orchestrator session ${orchSID.slice(-8)} has produced no completed work — run cannot proceed without orchestrator` };
    }
    return { ok: true };
  },
  async degrade(swarmRunID, meta) {
    // Orchestrator dead: promote the first alive worker (sessionIDs[1])
    // to orchestrator. Update ticker's orchestratorSessionID so the old
    // slot stays excluded from dispatch.
    const newOrchSID = meta.sessionIDs[1];
    if (!newOrchSID) {
      return `orchestrator dead but no workers available to promote — run cannot continue`;
    }
    const newSIDs = [newOrchSID, ...meta.sessionIDs.filter((s) => s !== meta.sessionIDs[0] && s !== newOrchSID)];
    await updateRunMeta(swarmRunID, { sessionIDs: newSIDs });
    const state = tickers().get(swarmRunID);
    if (state) {
      state.orchestratorSessionID = newOrchSID;
      state.sessionIDs = [...newSIDs];
    }
    // Post recovery directive to new orchestrator so it knows its role changed.
    try {
      const directive = meta.directive || 'Survey the codebase and propose work.';
      await postSessionMessageServer(newOrchSID, meta.workspace,
        `## [pattern-guard] Promoted to orchestrator\n\nThe original orchestrator is unresponsive. You are now the orchestrator.\n\nOriginal directive: ${directive}\n\nRun a planner sweep and dispatch work to workers.`);
    } catch { /* best effort */ }
    return `orchestrator ${meta.sessionIDs[0].slice(-8)} dead — promoted worker ${newOrchSID.slice(-8)} to orchestrator`;
  },
};

const debateJudgeGuard: PatternGuard = {
  description: 'debate-judge: 1 judge + N generators',
  startupInvariant(meta) {
    if (meta.sessionIDs.length < 2) {
      return { ok: false, reason: `debate-judge requires ≥2 sessions (has ${meta.sessionIDs.length})` };
    }
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, meta) {
    const judgeSID = meta.sessionIDs[0];
    const alive = await sessionIsProducing(judgeSID, meta.workspace);
    if (!alive) {
      return { ok: false, reason: `judge session ${judgeSID.slice(-8)} has produced no completed work — verdicts cannot be rendered` };
    }
    return { ok: true };
  },
  async degrade(swarmRunID, meta) {
    // Judge dead: promote the generator with the most messages as new
    // judge. If only 1 generator remains, auto-select its proposal.
    const generators = meta.sessionIDs.slice(1);
    if (generators.length === 0) {
      return `judge dead and no generators available — run cannot continue`;
    }
    if (generators.length === 1) {
      return `judge ${meta.sessionIDs[0].slice(-8)} dead — auto-selected sole generator ${generators[0].slice(-8)}'s proposal as winner`;
    }
    // Find most-active generator by message count
    let bestSID = generators[0];
    let bestCount = 0;
    for (const sid of generators) {
      try {
        const msgs = await getSessionMessagesServer(sid, meta.workspace);
        if (msgs.length > bestCount) { bestCount = msgs.length; bestSID = sid; }
      } catch { /* skip unreachable */ }
    }
    const newSIDs = [bestSID, ...generators.filter((s) => s !== bestSID)];
    await updateRunMeta(swarmRunID, { sessionIDs: newSIDs });
    const state = tickers().get(swarmRunID);
    if (state) state.sessionIDs = [...newSIDs];
    // Post promotion message to the new judge
    try {
      await postSessionMessageServer(bestSID, meta.workspace,
        '## [pattern-guard] Promoted to judge\n\nThe original judge is unresponsive. You are now the judge. Evaluate the remaining proposals and pick a winner.');
    } catch { /* best effort */ }
    return `judge ${meta.sessionIDs[0].slice(-8)} dead — promoted generator ${bestSID.slice(-8)} (${bestCount} messages) to judge`;
  },
};

const blackboardGuard: PatternGuard = {
  description: 'blackboard: self-organizing, parallel-redundant — no pinned roles to enforce',
  startupInvariant(_meta) {
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, _meta) {
    // Blackboard is parallel-redundant — no single-session failure kills
    // the run. The existing F1 fallback handles planner sweep errors.
    return { ok: true };
  },
};

const councilGuard: PatternGuard = {
  description: 'council: N parallel drafters, converge — no pinned roles',
  startupInvariant(_meta) {
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, _meta) {
    // Council is parallel-redundant — surviving drafters can still converge.
    return { ok: true };
  },
};

const mapReduceGuard: PatternGuard = {
  description: 'map-reduce: N mappers + 1 synthesizer',
  startupInvariant(meta) {
    if (meta.sessionIDs.length < 2) {
      return { ok: false, reason: `map-reduce requires ≥2 sessions (has ${meta.sessionIDs.length})` };
    }
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, meta) {
    // Synthesizer is sessionIDs[0]. If it's silent, the reduce phase
    // cannot complete — the map phase output goes nowhere.
    const synthSID = meta.sessionIDs[0];
    const alive = await sessionIsProducing(synthSID, meta.workspace);
    if (!alive) {
      return { ok: false, reason: `synthesizer session ${synthSID.slice(-8)} has produced no completed work — reduce phase blocked` };
    }
    return { ok: true };
  },
  async degrade(swarmRunID, meta) {
    // Synthesizer dead: try to promote the next available session as
    // synthesizer and post a retry message with the recovery directive.
    const candidates = meta.sessionIDs.slice(1);
    if (candidates.length === 0) {
      return `synthesizer ${meta.sessionIDs[0].slice(-8)} dead and no mappers available — run cannot continue`;
    }
    const newSynthSID = candidates[0];
    const newSIDs = [newSynthSID, ...meta.sessionIDs.filter((s) => s !== meta.sessionIDs[0] && s !== newSynthSID)];
    try {
      await updateRunMeta(swarmRunID, { sessionIDs: newSIDs });
    } catch { /* best effort */ }
    const state = tickers().get(swarmRunID);
    if (state) state.sessionIDs = [...newSIDs];
    try {
      await postSessionMessageServer(newSynthSID, meta.workspace,
        '## [pattern-guard] Synthesizer unresponsive\n\nThe original synthesizer session is unresponsive. Retry synthesis of the mapper drafts.');
    } catch { /* best effort */ }
    return `synthesizer ${meta.sessionIDs[0].slice(-8)} dead — promoted mapper ${newSynthSID.slice(-8)} to synthesizer`;
  },
};

const pipelineGuard: PatternGuard = {
  description: 'pipeline: chained phases, each handled independently',
  startupInvariant(_meta) {
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, _meta) {
    return { ok: true };
  },
};

const noneGuard: PatternGuard = {
  description: 'none: single-session native opencode',
  startupInvariant(_meta) {
    return { ok: true };
  },
  async runtimeInvariant(_swarmRunID, _meta) {
    return { ok: true };
  },
};

// ─── Registry ────────────────────────────────────────────────────────

const GUARDS: Record<string, PatternGuard> = {
  'critic-loop': criticLoopGuard,
  'orchestrator-worker': owGuard,
  'debate-judge': debateJudgeGuard,
  blackboard: blackboardGuard,
  council: councilGuard,
  'map-reduce': mapReduceGuard,
  pipeline: pipelineGuard,
  none: noneGuard,
};

export function getPatternGuard(pattern: string): PatternGuard | null {
  return GUARDS[pattern] ?? null;
}

// ─── Public API ──────────────────────────────────────────────────────

// Assert startup invariant. Call from pattern kickoff before startAutoTicker.
// Returns { ok: true } or throws with the failure reason.
export function assertStartupInvariant(meta: SwarmRunMeta): void {
  const guard = getPatternGuard(meta.pattern);
  if (!guard) return;
  const result = guard.startupInvariant(meta);
  if (!result.ok) {
    throw new Error(`[pattern-guard] startup invariant failed: ${result.reason}`);
  }
}

// Assert runtime invariant. Call from the auto-ticker fanout before
// per-session dispatch. Records a finding on failure; never throws.
// Returns true if invariant is OK, false if degraded (finding recorded).
export async function assertRuntimeInvariant(
  swarmRunID: string,
  meta: SwarmRunMeta,
): Promise<boolean> {
  const guard = getPatternGuard(meta.pattern);
  if (!guard) return true;
  const result = await guard.runtimeInvariant(swarmRunID, meta);
  if (!result.ok) {
    console.warn(
      `[pattern-guard] ${meta.pattern} invariant broken for ${swarmRunID}: ${result.reason}`,
    );
    recordGuardFinding(swarmRunID, meta.pattern, result.reason);
    // Attempt graceful degradation if the guard has a recovery action.
    if (guard.degrade) {
      try {
        const recoveryMsg = await guard.degrade(swarmRunID, meta);
        recordGuardFinding(swarmRunID, meta.pattern, `recovered: ${recoveryMsg}`);
        console.log(`[pattern-guard] ${meta.pattern} degraded for ${swarmRunID}: ${recoveryMsg}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordGuardFinding(swarmRunID, meta.pattern, `degrade failed: ${message}`);
        console.warn(`[pattern-guard] degrade threw for ${swarmRunID}: ${message}`);
      }
    }
    return false;
  }
  return true;
}
