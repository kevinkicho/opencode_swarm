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

import 'server-only';

import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { waitForSessionIdle } from './blackboard/coordinator';
import { extractLatestAssistantText, harvestDrafts, snapshotKnownIDs } from './harvest-drafts';
import { withRunGuard } from './run-guard';
import { recordPartialOutcome } from './degraded-completion';
import { formatWallClockState, isWallClockExpired } from './swarm-bounds';
import type { OpencodeMessage } from '../opencode/types';

// Default auto-round count when teamSize is small (≤ 4). 3 = R1
// divergent + R2 exchange + R3 converge, which is the minimum shape
// that gets to "shared conclusions." Higher counts yield diminishing
// returns: by R4 agents mostly restate R3.
// Configurable later via request body (`rounds`) or run bounds.
const DEFAULT_MAX_ROUNDS = 3;

// Scale-aware round cap (#98). The MAXTEAM-2026-04-26 stress test
// found council-style deliberation at teamSize=8 ran 24 turns of
// cross-talk (8 members × 3 rounds) and never converged within the
// 30-min cap; deliberate-execute's phase-1 council got stuck for the
// same reason and never reached synthesis. With more members, each
// round already carries more diverse input, so we drop the round
// count to compensate. Larger pools converge or hit the convergence
// auto-stop threshold (jaccard ≥ 0.85) faster, OR they don't —
// either way, fewer rounds gets us to phase 2 before wall-clock.
//
// Empirical envelope (assuming ~1-2 min/turn × N members per round):
//   teamSize 2-4 × 3 rounds = 6-12 turns ≈ 6-24 min  ✓ within cap
//   teamSize 5-6 × 2 rounds = 10-12 turns ≈ 10-24 min  ✓ within cap
//   teamSize 7-8 × 2 rounds = 14-16 turns ≈ 14-32 min  ⚠ tight
//                  × 3 rounds = 21-24 turns ≈ 21-48 min  ✗ stress test verified
//
// The user can still override via opts.maxRounds; this just sets the
// default that fires when no override is supplied.
export function recommendedDeliberationRounds(teamSize: number): number {
  if (teamSize >= 5) return 2;
  return DEFAULT_MAX_ROUNDS;
}

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

// HARDENING_PLAN.md#C1 — `extractLatestAssistantText` lifted to
// harvest-drafts.ts (the helper module shared with map-reduce + others).
// Pre-fix this function existed character-identical in 6 files; the
// drift risk was real.

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
  // Default round cap is teamSize-aware (#98). Caller's opts.maxRounds
  // wins when set; otherwise we look up meta.sessionIDs.length below
  // (after withRunGuard hands us the meta) and pick the recommended
  // value for that size.
  const maxRoundsOverride = opts.maxRounds;

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

  // Resolve the round cap now that we have meta.sessionIDs.length.
  // Override (caller-supplied) wins; otherwise use the teamSize-aware
  // recommendation. minRounds=2 because a single-round council is
  // just an unmoderated R1 fan-out — no exchange phase, no real
  // council shape.
  const maxRounds = Math.max(
    2,
    maxRoundsOverride ?? recommendedDeliberationRounds(meta.sessionIDs.length),
  );
  if (
    maxRoundsOverride === undefined &&
    maxRounds < DEFAULT_MAX_ROUNDS
  ) {
    console.log(
      `[council] run ${swarmRunID}: scale-aware round cap = ${maxRounds} rounds for teamSize=${meta.sessionIDs.length} (#98). Override via opts.maxRounds.`,
    );
  }

  // Snapshot the set of known message IDs per session. The directive
  // post happened just before this function was called (in the route),
  // so each session already has its Round-0 user message plus the base
  // system. Anything that arrives after this snapshot is Round-1 and up.
  const knownIDsBySession = await snapshotKnownIDs(meta, '[council]');

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
    // per-round budget. harvestDrafts encapsulates the fan-out shape;
    // we update knownIDsBySession from the row's newKnownIDs so the
    // next round only awaits genuinely-new messages.
    const deadline = Date.now() + ROUND_WAIT_MS;
    const harvest = await harvestDrafts(meta, {
      knownIDsBySession,
      deadline,
      contextLabel: '[council]',
    });
    for (const row of harvest) {
      knownIDsBySession.set(row.sessionID, row.newKnownIDs);
    }
    const drafts = harvest.map((r) => ({ sessionID: r.sessionID, text: r.text }));

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

  // #7.Q32 — wait for the FINAL round's responses. Without this harvest
  // the loop posts maxRounds prompts but only awaits maxRounds-1 round
  // of responses, leaving the last round's assistant turns frozen at
  // parts=0 forever (visible in opencode as zombie placeholders). The
  // final-round prompt explicitly asks each member to vote on the
  // accepted draft — those votes are the council's most refined output
  // and we were throwing them away. Reproduced 2026-04-26 on
  // run_moflgdpi_xf703h: 3 sessions stuck at parts=0 for 2h+ until
  // teardown. Now: wait for round-maxRounds responses, capture them
  // as a finding so they're durably visible in /retro and the board.
  const finalDeadline = Date.now() + ROUND_WAIT_MS;
  const finalHarvest = await harvestDrafts(meta, {
    knownIDsBySession,
    deadline: finalDeadline,
    contextLabel: '[council]',
  });
  for (const row of finalHarvest) {
    knownIDsBySession.set(row.sessionID, row.newKnownIDs);
  }
  const finalDrafts = finalHarvest.map((r) => ({
    sessionID: r.sessionID,
    text: r.text,
  }));
  latestDrafts = finalDrafts;
  const finalPresent = finalDrafts.filter((d) => d.text !== null);
  lastCompletedRound = maxRounds;

  if (finalPresent.length > 0) {
    console.log(
      `[council] run ${swarmRunID} — final round (${maxRounds}) harvested: ${finalPresent.length}/${finalDrafts.length} member(s) responded`,
    );
    // Capture the final-round votes as a finding so /retro and the
    // board carry them. recordPartialOutcome's "phase" field is free-
    // form; "complete" signals this isn't a failure. The summary
    // includes each member's vote text so the human can read the
    // verdicts without scrolling individual session transcripts.
    recordPartialOutcome(swarmRunID, {
      pattern: 'council',
      phase: `complete (round ${maxRounds}/${maxRounds})`,
      reason: 'auto-rounds-complete',
      summary: buildPartialSummary(maxRounds + 1),
    });
  } else {
    console.warn(
      `[council] run ${swarmRunID} — final round (${maxRounds}) produced no drafts; council output is incomplete`,
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'council',
      phase: `final-round (${maxRounds}/${maxRounds})`,
      reason: 'final-round-no-drafts',
      summary: buildPartialSummary(maxRounds + 1),
    });
  }

  console.log(
    `[council] run ${swarmRunID} — auto-rounds complete (${maxRounds} rounds total)`,
  );
    },
  );
}
