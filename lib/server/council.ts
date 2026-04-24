// Auto-round orchestrator for council. When a council run is created, the
// POST /api/swarm/run handler fires this in the background. It detects
// when all sessions go idle at the end of a round, harvests each member's
// latest assistant text, and posts Round-(N+1) to every session with the
// full set of peer drafts embedded.
//
// Why server-side, not client-polled? A browser tab that closes mid-run
// would freeze the pattern — Round 2 would never fire. Auto-rounds belong
// with the other background orchestrators (map-reduce synthesis,
// blackboard auto-ticker) so the pattern's shape is a property of the
// run, not of any particular viewer.
//
// Stance check: this doesn't violate "humans set bounds + observe, agents
// self-select" (memory/feedback_no_role_hierarchy.md). A phase transition
// in the protocol is not a supervisor — map-reduce's synthesis phase is
// the same shape and has been fine. What we still reject is role pinning
// among agents; every council member does the same thing every round.
//
// Shape per round N (N ≥ 2):
//   1. wait until every session's Round-(N-1) assistant turn completes
//      (via waitForSessionIdle from blackboard/coordinator)
//   2. harvest the latest completed assistant text from each session as
//      that member's Round-(N-1) draft
//   3. if fewer than 2 drafts present, bail — nothing to deliberate
//   4. build a Round-N prompt embedding every draft, fan it to every
//      session in parallel (allSettled — one slow member doesn't stall)
//
// Stops on: maxRounds reached, <2 drafts present at any round boundary,
// per-round wait timeout fired for all sessions, or a fetch throws.

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { finalizeRun } from './finalize-run';
import { getRun } from './swarm-registry';
import type { OpencodeMessage } from '../opencode/types';

// Default auto-round count. 3 = R1 divergent + R2 exchange + R3 converge,
// which is the minimum shape that gets to "shared conclusions." Higher
// counts yield diminishing returns: by R4 agents mostly restate R3.
// Configurable later via request body (`rounds`) or run bounds.
const DEFAULT_MAX_ROUNDS = 3;

// Per-round wait ceiling. 20 min is generous — each council member only
// does one reply per round, which in practice completes in 1–3 min. A
// blown deadline logs and proceeds with whatever text we have.
const ROUND_WAIT_MS = 20 * 60 * 1000;

// Shared with map-reduce.ts (same shape, intentionally duplicated to keep
// these server-side pattern modules decoupled — cross-imports between
// pattern orchestrators make it harder to retire a pattern cleanly).
function extractLatestAssistantText(messages: OpencodeMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.info.role !== 'assistant') continue;
    if (!m.info.time.completed) continue;
    const texts = m.parts.filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text');
    if (texts.length === 0) continue;
    return texts[texts.length - 1].text;
  }
  return null;
}

function buildRoundPrompt(
  roundNum: number,
  drafts: Array<{ sessionID: string; text: string | null }>,
): string {
  const blocks = drafts
    .filter((d) => d.text !== null)
    .map(
      (d) =>
        `--- member ${d.sessionID.slice(-8)} ---\n${(d.text ?? '').trim()}`,
    );

  // Round 2 wording matches the existing ReconcileStrip manual action so
  // an agent can't tell whether the round was fired by the user clicking
  // "↻ round 2" or by this orchestrator — same prompt shape either way.
  // Round ≥3 asks for convergence explicitly: by the third pass members
  // should either agree or flag hard disagreements, not restate.
  const header =
    roundNum === 2
      ? 'Round 2. Below are the Round-1 drafts from every council member. ' +
        "Revise your own response in light of the others, or state clearly " +
        "which member's draft you accept and why. Respond now."
      : `Round ${roundNum}. Below are the Round-${roundNum - 1} drafts from every ` +
        'council member. Continue deliberating: converge on shared conclusions ' +
        'where you can, and flag irreconcilable differences clearly. Respond now.';

  return `${header}\n\n${blocks.join('\n\n')}`;
}

export async function runCouncilRounds(
  swarmRunID: string,
  opts: { maxRounds?: number } = {},
): Promise<void> {
  try {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (maxRounds < 2) return;

  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(`[council] run ${swarmRunID} not found — auto-rounds aborted`);
    return;
  }
  if (meta.pattern !== 'council') {
    console.warn(
      `[council] run ${swarmRunID} has pattern '${meta.pattern}', not council — auto-rounds aborted`,
    );
    return;
  }
  if (meta.sessionIDs.length < 2) {
    // A single-session council is just a chat; there's nothing to
    // reconcile across members. The POST handler already clamps to
    // teamSize ≥ 2 for council, but defend anyway.
    return;
  }

  // Snapshot the set of known message IDs per session. The directive
  // post happened just before this function was called (in the route),
  // so each session already has its Round-0 user message plus the base
  // system. Anything that arrives after this snapshot is Round-1 and up.
  const knownIDsBySession = new Map<string, Set<string>>();
  for (const sid of meta.sessionIDs) {
    try {
      const msgs = await getSessionMessagesServer(sid, meta.workspace);
      knownIDsBySession.set(sid, new Set(msgs.map((m) => m.info.id)));
    } catch {
      knownIDsBySession.set(sid, new Set());
    }
  }

  for (let roundNum = 2; roundNum <= maxRounds; roundNum += 1) {
    const deadline = Date.now() + ROUND_WAIT_MS;
    const drafts: Array<{ sessionID: string; text: string | null }> = [];

    for (const sid of meta.sessionIDs) {
      const known = knownIDsBySession.get(sid) ?? new Set<string>();
      const result = await waitForSessionIdle(sid, meta.workspace, known, deadline);
      if (!result.ok) {
        console.warn(
          `[council] session ${sid} wait failed (${result.reason}) — using last completed text if any`,
        );
      }

      // Always fetch current state — even on timeout, a partially-done
      // assistant turn may have a final text we can use. Update
      // knownIDs so the next round only awaits genuinely new messages.
      let text: string | null = null;
      try {
        const msgs = await getSessionMessagesServer(sid, meta.workspace);
        text = extractLatestAssistantText(msgs);
        knownIDsBySession.set(sid, new Set(msgs.map((m) => m.info.id)));
      } catch (err) {
        console.warn(
          `[council] session ${sid} message fetch failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      drafts.push({ sessionID: sid, text });
    }

    const present = drafts.filter((d) => d.text !== null);
    if (present.length < 2) {
      console.warn(
        `[council] run ${swarmRunID} — only ${present.length}/${drafts.length} drafts present before round ${roundNum}, auto-rounds stopping`,
      );
      return;
    }

    const prompt = buildRoundPrompt(roundNum, drafts);
    console.log(
      `[council] run ${swarmRunID} — firing round ${roundNum} to ${meta.sessionIDs.length} sessions (${present.length} drafts embedded)`,
    );

    const postResults = await Promise.allSettled(
      meta.sessionIDs.map((sid) =>
        postSessionMessageServer(sid, meta.workspace, prompt),
      ),
    );
    postResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(
          `[council] round ${roundNum} post failed for session ${meta.sessionIDs[i]}:`,
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
      }
    });
  }

  console.log(
    `[council] run ${swarmRunID} — auto-rounds complete (${maxRounds} rounds total)`,
  );
  } finally {
    // Abort any lingering in-flight turns on session sessions so
    // closing orchestrators don't leak tokens. No-op on idle sessions.
    await finalizeRun(swarmRunID, 'council');
  }
}
