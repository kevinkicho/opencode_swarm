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
import { withRunGuard } from './run-guard';
import { recordPartialOutcome } from './degraded-completion';
import { formatWallClockState, isWallClockExpired } from './swarm-bounds';
import type { OpencodeMessage } from '../opencode/types';

// Default auto-round count. 3 = R1 divergent + R2 exchange + R3 converge,
// which is the minimum shape that gets to "shared conclusions." Higher
// counts yield diminishing returns: by R4 agents mostly restate R3.
// Configurable later via request body (`rounds`) or run bounds.
const DEFAULT_MAX_ROUNDS = 3;

// Per-round wait ceiling. 10 min was the spec target
// (PATTERN_DESIGN/council.md I4); empirically council members reply in
// 1–3 min so this is generous headroom. A blown deadline records the
// member as no-draft (null text) and the round proceeds with the
// remaining drafts — single hung members no longer stall the council.
const ROUND_WAIT_MS = 10 * 60 * 1000;

// PATTERN_DESIGN/council.md I1 — convergence-detection auto-stop.
// Mean-pairwise-token-jaccard ≥ this value at round R(N-1)'s harvest
// short-circuits rounds N..maxRounds. Threshold matches the
// council-rail UI's "high" tone (≥ 0.8) but tightened to 0.85 here
// because we're making a binding decision (skip work) rather than
// just labeling a row.
const COUNCIL_CONVERGENCE_THRESHOLD = 0.85;

const CONV_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that',
]);

function tokenizeForConvergence(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3 || CONV_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export function meanPairwiseJaccard(texts: string[]): number | null {
  const sets = texts.filter(Boolean).map((t) => tokenizeForConvergence(t));
  if (sets.length < 2) return null;
  let pairs = 0;
  let sum = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      if (a.size === 0 && b.size === 0) continue;
      let intersect = 0;
      for (const t of a) if (b.has(t)) intersect += 1;
      const union = a.size + b.size - intersect;
      if (union === 0) continue;
      sum += intersect / union;
      pairs += 1;
    }
  }
  return pairs > 0 ? sum / pairs : null;
}

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
  isFinalRound: boolean,
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
  let header: string;
  if (roundNum === 2) {
    header =
      'Round 2. Below are the Round-1 drafts from every council member. ' +
      "Revise your own response in light of the others, or state clearly " +
      "which member's draft you accept and why. Respond now.";
  } else {
    header =
      `Round ${roundNum}. Below are the Round-${roundNum - 1} drafts from every ` +
      'council member. Continue deliberating: converge on shared conclusions ' +
      'where you can, and flag irreconcilable differences clearly. Respond now.';
  }

  // PATTERN_DESIGN/council.md I3 — minority-view preservation. On the
  // final round, instruct each member to spell out any dissenting
  // position (their own or another member's) explicitly, so a 3-vs-2
  // split doesn't quietly collapse into the majority's text. Doesn't
  // change earlier rounds — the deliberation phase should still prefer
  // convergence; only the final round's summary is contractually
  // required to surface dissent.
  if (isFinalRound) {
    header +=
      '\n\nThis is the FINAL round. In your response, if any member has ' +
      'staked out a position that differs from yours OR yours differs from the ' +
      "majority's, devote a clearly-labeled `Dissent:` section at the end " +
      'naming the disagreeing member(s) and summarizing the dissenting position ' +
      'in 1-3 sentences. If the council is fully aligned, state "Dissent: none" ' +
      'explicitly. Do not silently drop minority views.';
  }

  return `${header}\n\n${blocks.join('\n\n')}`;
}

export async function runCouncilRounds(
  swarmRunID: string,
  opts: { maxRounds?: number } = {},
): Promise<void> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (maxRounds < 2) return;

  // Council accepts both 'council' (standalone) and 'deliberate-execute'
  // (when called as that pattern's phase-1 deliberation).
  // 2026-04-25 fix: previously rejected any non-'council' pattern,
  // which silently no-op'd every deliberate-execute kickoff. POSTMORTEM
  // cross-ref: 2026-04-25-agent-name-silent-drop.md (sibling failure).
  await withRunGuard(
    swarmRunID,
    {
      expectedPattern: ['council', 'deliberate-execute'],
      context: 'council',
    },
    async (meta) => {
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

  // #73 — track latest drafts so a partial-outcome record can capture
  // what survived if council aborts mid-rounds (wall-clock cap, fewer
  // than 2 drafts, etc.).
  let latestDrafts: Array<{ sessionID: string; text: string | null }> = [];
  let lastCompletedRound = 1; // Round 1 = initial directive (kicked off by route)
  function buildPartialSummary(roundNum: number): string {
    const parts: string[] = [];
    parts.push(
      `Council aborted at round ${roundNum}/${maxRounds}. Last completed round: ${lastCompletedRound}.`,
    );
    if (latestDrafts.length > 0) {
      const present = latestDrafts.filter((d) => d.text !== null);
      parts.push(`Latest drafts: ${present.length}/${latestDrafts.length} members produced text.`);
      parts.push('');
      for (const d of present) {
        parts.push(`--- session ${d.sessionID.slice(-8)} ---`);
        parts.push(d.text ?? '');
        parts.push('');
      }
    }
    return parts.join('\n');
  }

  for (let roundNum = 2; roundNum <= maxRounds; roundNum += 1) {
    // Wall-clock cap (#85) — non-ticker patterns previously ignored
    // bounds.minutesCap silently. Check at the top of each round so
    // partial deliberation already produced stays in opencode for the
    // human; we just stop initiating new rounds.
    if (isWallClockExpired(meta, meta.createdAt)) {
      console.warn(
        `[council] run ${swarmRunID}: wall-clock cap reached (${formatWallClockState(meta, meta.createdAt)}) — aborting at round ${roundNum}/${maxRounds}`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'council',
        phase: `round ${roundNum}/${maxRounds} (wall-clock)`,
        reason: 'wall-clock-cap',
        summary: buildPartialSummary(roundNum),
      });
      return;
    }
    // PATTERN_DESIGN/council.md I4 — per-member wait runs in parallel
    // so each member gets the full ROUND_WAIT_MS. Sequential waits
    // would have shared the deadline (member 5 starts with member 1's
    // remaining time) and the round-end could've blown past the
    // per-round budget. Promise.all preserves draft order; failures
    // are absorbed into per-member text=null at the resolve step.
    const deadline = Date.now() + ROUND_WAIT_MS;
    const drafts = await Promise.all(
      meta.sessionIDs.map(async (sid) => {
        const known = knownIDsBySession.get(sid) ?? new Set<string>();
        const result = await waitForSessionIdle(sid, meta.workspace, known, deadline);
        if (!result.ok) {
          console.warn(
            `[council] session ${sid} wait failed (${result.reason}) — recording as no-draft for round ${roundNum} (PATTERN_DESIGN/council.md I4)`,
          );
        }
        // Always fetch current state — even on timeout, a partially-
        // done assistant turn may have a final text we can use.
        // Update knownIDs so the next round only awaits genuinely new
        // messages.
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
        return { sessionID: sid, text };
      }),
    );

    latestDrafts = drafts;
    const present = drafts.filter((d) => d.text !== null);
    if (present.length < 2) {
      console.warn(
        `[council] run ${swarmRunID} — only ${present.length}/${drafts.length} drafts present before round ${roundNum}, auto-rounds stopping`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'council',
        phase: `round ${roundNum}/${maxRounds} draft-fan-in`,
        reason: `too-few-drafts (${present.length}/${drafts.length})`,
        summary: buildPartialSummary(roundNum),
      });
      return;
    }
    lastCompletedRound = roundNum - 1; // round (roundNum-1) drafts are now in hand

    // PATTERN_DESIGN/council.md I1 — convergence-detection auto-stop.
    // The drafts we just harvested are responses to round (roundNum-1)'s
    // prompt (or the initial directive when roundNum=2). If they converge
    // tightly enough, skip remaining rounds and let the caller proceed
    // (deliberate-execute hands off to synthesis; standalone council
    // returns to its stopping condition). Only fires when the run opted
    // in via meta.autoStopOnConverge.
    if (meta.autoStopOnConverge) {
      const conv = meanPairwiseJaccard(
        present.map((d) => d.text ?? ''),
      );
      if (conv !== null && conv >= COUNCIL_CONVERGENCE_THRESHOLD) {
        console.log(
          `[council] run ${swarmRunID} — R${roundNum - 1} convergence ${(conv * 100).toFixed(0)}% ≥ ${(COUNCIL_CONVERGENCE_THRESHOLD * 100).toFixed(0)}% — auto-stopping rounds (PATTERN_DESIGN/council.md I1)`,
        );
        return;
      }
    }

    const prompt = buildRoundPrompt(roundNum, drafts, roundNum === maxRounds);
    console.log(
      `[council] run ${swarmRunID} — firing round ${roundNum} to ${meta.sessionIDs.length} sessions (${present.length} drafts embedded)`,
    );

    const postResults = await Promise.allSettled(
      meta.sessionIDs.map((sid, i) =>
        postSessionMessageServer(sid, meta.workspace, prompt, {
          model: meta.teamModels?.[i],
        }),
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
    },
  );
}
