// Map-reduce orchestration.
//
// Map phase: every session gets the same base directive plus its own scope
// annotation ("your slice: src/api/"). Sessions work in parallel; the backend
// waits for all of them to go idle.
//
// Reduce phase (v2): once every map session has settled, we insert a single
// `synthesize` item onto the run's blackboard with the full synthesis prompt
// as its content. The coordinator's tick loop then picks the first idle
// session, claims the item CAS-safely (open → claimed → in-progress), posts
// the prompt verbatim, waits for the session to idle, and transitions the
// item to done. Any idle session can win the claim — the synthesizer is a
// phase, not a pinned role.
//
// Why this shape over "post to sessionIDs[0]": (a) the claim is observable
// from the board (who ran synthesis, when, over which files) where before it
// was invisible dispatcher state; (b) the item is idempotent under a
// deterministic id, so a double-firing of this function produces one row
// and one claim, not two; (c) the same CAS-lifecycle forensics that govern
// blackboard todos now govern the reduce phase for free.
//
// Server-only. Never imported from client code.

import 'server-only';

import { withRunGuard } from './run-guard';
import { getSessionMessagesServer, postSessionMessageServer } from './opencode-server';
import { tickCoordinator, waitForSessionIdle } from './blackboard/coordinator';
import { extractLatestAssistantText, harvestDrafts, snapshotKnownIDs } from './harvest-drafts';
import { recordPartialOutcome } from './degraded-completion';
import { getBoardItem, insertBoardItem } from './blackboard/store';
import { checkWallClockExpired } from './swarm-bounds';
import { THRESHOLDS, TIMINGS } from './pattern-tunables';
import {
  deriveSlices,
  detectScopeImbalance,
  buildScopedDirective,
  buildMapPhaseSummary,
  buildSynthesisPrompt,
  pickCriticSession,
  buildCriticPrompt,
  parseCriticVerdict,
  buildSynthesisRevisePrompt,
  truncateDraftForSynthesis,
  MAX_SYNTHESIS_CRITIC_REVISIONS,
} from './map-reduce/parsers';

export { deriveSlices, detectScopeImbalance, buildScopedDirective, truncateDraftForSynthesis };

const SYNTHESIS_CRITIC_WAIT_MS = TIMINGS.mapReduce.synthesisCriticWaitMs;

export async function runMapReduceSynthesis(swarmRunID: string): Promise<void> {
  await withRunGuard(
  swarmRunID,
  { expectedPattern: 'map-reduce', context: 'map-reduce' },
  async (meta) => {
    if (meta.sessionIDs.length < 2) {
      console.warn(
        `[map-reduce] run ${swarmRunID} has only ${meta.sessionIDs.length} session(s) — synthesis aborted`,
      );
      return;
    }

    const SESSION_WAIT_MS = TIMINGS.mapReduce.sessionWaitMs;
    const deadline = Date.now() + SESSION_WAIT_MS;
    const knownIDsBySession = await snapshotKnownIDs(meta, '[map-reduce]');
    const waitResults = await harvestDrafts(meta, {
      knownIDsBySession,
      deadline,
      contextLabel: '[map-reduce]',
    });
    const drafts: Array<{ sessionID: string; text: string | null }> =
      waitResults.map((r) => ({ sessionID: r.sessionID, text: r.text }));

    const present = drafts.filter((d) => d.text !== null);
    const failedCount = waitResults.filter((r) => !r.ok || r.text === null).length;
    const totalSessionCount = meta.sessionIDs.length;

    if (present.length === 0) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — no draft texts harvested, synthesis skipped`,
      );
      recordPartialOutcome(swarmRunID, {
        pattern: 'map-reduce',
        phase: 'map-fan-in',
        reason: 'zero-drafts',
        summary: buildMapPhaseSummary(present, totalSessionCount, failedCount),
      });
      return;
    }

    const tolerance = meta.partialMapTolerance;
    if (tolerance) {
      if (present.length < tolerance.minMembers) {
        console.warn(
          `[map-reduce] run ${swarmRunID} — only ${present.length}/${meta.sessionIDs.length} drafts harvested, below minMembers=${tolerance.minMembers} — synthesis aborted`,
        );
        recordPartialOutcome(swarmRunID, {
          pattern: 'map-reduce',
          phase: 'tolerance-gate (minMembers)',
          reason: `drafts=${present.length}<minMembers=${tolerance.minMembers}`,
          summary: buildMapPhaseSummary(present, totalSessionCount, failedCount),
        });
        return;
      }
      if (failedCount > tolerance.maxMemberFailures) {
        console.warn(
          `[map-reduce] run ${swarmRunID} — ${failedCount} member(s) failed, above maxMemberFailures=${tolerance.maxMemberFailures} — synthesis aborted`,
        );
        recordPartialOutcome(swarmRunID, {
          pattern: 'map-reduce',
          phase: 'tolerance-gate (maxMemberFailures)',
          reason: `failed=${failedCount}>max=${tolerance.maxMemberFailures}`,
          summary: buildMapPhaseSummary(present, totalSessionCount, failedCount),
        });
        return;
      }
      if (failedCount > 0) {
        console.log(
          `[map-reduce] run ${swarmRunID} — proceeding with ${present.length}/${meta.sessionIDs.length} drafts, ${failedCount} failures within tolerance`,
        );
      }
    }

    const synthesisPrompt = buildSynthesisPrompt(drafts, meta.directive, failedCount);
    const itemID = `synth_${swarmRunID}`;

    const existing = getBoardItem(swarmRunID, itemID);
    if (existing) {
      console.log(
        `[map-reduce] run ${swarmRunID} — synthesis item ${itemID} already exists (${existing.status}); skipping insert`,
      );
    } else {
      try {
        insertBoardItem(swarmRunID, {
          id: itemID,
          kind: 'synthesize',
          status: 'open',
          content: synthesisPrompt,
        });
        console.log(
          `[map-reduce] run ${swarmRunID} — synthesis item ${itemID} inserted with ${present.length}/${drafts.length} drafts`,
        );
      } catch (err) {
        console.warn(
          `[map-reduce] run ${swarmRunID} — synthesis item insert failed:`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
    }

    const DISPATCH_DEADLINE_MS = TIMINGS.mapReduce.dispatchDeadlineMs;
    const TICK_INTERVAL_MS = TIMINGS.mapReduce.tickIntervalMs;
    const dispatchDeadline = Date.now() + DISPATCH_DEADLINE_MS;

    while (Date.now() < dispatchDeadline) {
      if (checkWallClockExpired(swarmRunID, meta, 'synthesis-dispatch', buildMapPhaseSummary(present, totalSessionCount, failedCount))) {
        return;
      }
      const outcome = await tickCoordinator(swarmRunID);
      if (outcome.status === 'picked' && outcome.itemID === itemID) {
        console.log(
          `[map-reduce] run ${swarmRunID} — synthesis claimed by ${outcome.sessionID} and completed`,
        );
        if (meta.enableSynthesisCritic) {
          await runSynthesisCriticGate(meta, drafts, outcome.sessionID);
        }
        return;
      }
      if (outcome.status === 'stale' && outcome.itemID === itemID) {
        console.warn(
          `[map-reduce] run ${swarmRunID} — synthesis stale: ${outcome.reason}`,
        );
        recordPartialOutcome(swarmRunID, {
          pattern: 'map-reduce',
          phase: 'synthesis-claim',
          reason: `stale: ${outcome.reason.slice(0, 60)}`,
          summary: buildMapPhaseSummary(present, totalSessionCount, failedCount),
        });
        return;
      }
      await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
    }

    console.warn(
      `[map-reduce] run ${swarmRunID} — synthesis dispatch deadline exceeded; item ${itemID} left for forensics`,
    );
    recordPartialOutcome(swarmRunID, {
      pattern: 'map-reduce',
      phase: 'synthesis-dispatch-deadline',
      reason: 'deadline-exceeded',
      summary: buildMapPhaseSummary(present, totalSessionCount, failedCount),
    });
  },
  );
}

async function runSynthesisCriticGate(
  meta: import('@/lib/swarm-run-types').SwarmRunMeta,
  drafts: Array<{ sessionID: string; text: string | null }>,
  synthesizerSessionID: string,
): Promise<void> {
  const swarmRunID = meta.swarmRunID;
  const criticSID = pickCriticSession(meta.sessionIDs, synthesizerSessionID);
  if (!criticSID) {
    console.warn(
      `[map-reduce] run ${swarmRunID} — no peer session available for synthesis-critic gate (only synthesizer in pool); skipping`,
    );
    return;
  }

  for (let attempt = 1; attempt <= MAX_SYNTHESIS_CRITIC_REVISIONS; attempt += 1) {
    let synthesisText: string | null = null;
    try {
      const msgs = await getSessionMessagesServer(
        synthesizerSessionID,
        meta.workspace,
      );
      synthesisText = extractLatestAssistantText(msgs);
    } catch (err) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — synthesis fetch for critic failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (!synthesisText) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — synthesizer produced no text; critic gate aborted`,
      );
      return;
    }

    let criticKnownIDs = new Set<string>();
    try {
      const before = await getSessionMessagesServer(criticSID, meta.workspace);
      criticKnownIDs = new Set(before.map((m) => m.info.id));
    } catch {
    }

    const criticPrompt = buildCriticPrompt(synthesisText, drafts);
    try {
      await postSessionMessageServer(
        criticSID,
        meta.workspace,
        criticPrompt,
        { model: meta.teamModels?.[meta.sessionIDs.indexOf(criticSID)] },
      );
    } catch (err) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — critic prompt post failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    const criticDeadline = Date.now() + SYNTHESIS_CRITIC_WAIT_MS;
    const criticWait = await waitForSessionIdle(
      criticSID,
      meta.workspace,
      criticKnownIDs,
      criticDeadline,
    );
    if (!criticWait.ok) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — critic wait failed (${criticWait.reason}); shipping current synthesis as final`,
      );
      return;
    }

    let criticText: string | null = null;
    try {
      const after = await getSessionMessagesServer(criticSID, meta.workspace);
      criticText = extractLatestAssistantText(after);
    } catch (err) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — critic fetch failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (!criticText) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — critic produced no text; shipping synthesis as final`,
      );
      return;
    }

    const { verdict, feedback } = parseCriticVerdict(criticText);
    if (verdict === 'approved') {
      console.log(
        `[map-reduce] run ${swarmRunID} — synthesis APPROVED by critic on attempt ${attempt}`,
      );
      return;
    }
    if (verdict === 'unclear') {
      console.warn(
        `[map-reduce] run ${swarmRunID} — critic verdict unparseable (no APPROVED/REVISE keyword); shipping synthesis as final`,
      );
      return;
    }

    console.log(
      `[map-reduce] run ${swarmRunID} — synthesis REVISE on attempt ${attempt}`,
    );
    if (attempt >= MAX_SYNTHESIS_CRITIC_REVISIONS) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — max ${MAX_SYNTHESIS_CRITIC_REVISIONS} revisions reached; shipping current synthesis as final`,
      );
      return;
    }

    let synthKnownIDs = new Set<string>();
    try {
      const before = await getSessionMessagesServer(
        synthesizerSessionID,
        meta.workspace,
      );
      synthKnownIDs = new Set(before.map((m) => m.info.id));
    } catch {
    }

    const revisePrompt = buildSynthesisRevisePrompt(
      feedback,
      attempt,
      MAX_SYNTHESIS_CRITIC_REVISIONS,
    );
    try {
      await postSessionMessageServer(
        synthesizerSessionID,
        meta.workspace,
        revisePrompt,
        meta.synthesisModel ? { model: meta.synthesisModel } : {},
      );
    } catch (err) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — synthesizer revise-post failed:`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    const synthDeadline = Date.now() + SYNTHESIS_CRITIC_WAIT_MS;
    const synthWait = await waitForSessionIdle(
      synthesizerSessionID,
      meta.workspace,
      synthKnownIDs,
      synthDeadline,
    );
    if (!synthWait.ok) {
      console.warn(
        `[map-reduce] run ${swarmRunID} — synthesizer revise wait failed (${synthWait.reason}); shipping prior synthesis as final`,
      );
      return;
    }
  }
}