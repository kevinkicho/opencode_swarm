// Ambition-ratchet planner sweep. On auto-idle the ticker asks the
// planner for work at the next tier of ambition rather than stopping.
// If the escalation seeds items → reset idle counters + record the new
// tier. If it produces zero → bump tier anyway so the next cascade
// tries the tier above; at MAX_TIER, flip `tierExhausted` so the next
// cascade stops for real. See SWARM_PATTERNS.md "Tiered execution"
// for the full contract; memory/project_ambition_ratchet.md for the
// design decision context.
//
// Extracted from auto-ticker.ts in #106 phase 3e.

import 'server-only';

import { updateRunMeta } from '../../swarm-registry';
import { listBoardItems } from '../store';
import { attemptColdFileSeeding } from '../cold-file-seed';
import { MAX_TIER, TIER_LADDER } from '../planner';
import { livePlanner } from './live-exports';
import { maybeRunAudit } from './audit';
import {
  MAX_ORCHESTRATOR_REPLANS,
  orchestratorReplanCapHit,
} from './policies';
import { stopAutoTicker } from './stop';
import type { TickerState } from './types';

export async function attemptTierEscalation(state: TickerState): Promise<void> {
  const swarmRunID = state.swarmRunID;

  // PATTERN_DESIGN/orchestrator-worker.md I1 — hard cap on re-plan
  // loops. Only enforced for orchestrator-worker. Self-organizing
  // patterns can re-plan freely. Read meta on the same path we use
  // elsewhere (~ms cost; the cap check is rare).
  if (await orchestratorReplanCapHit(swarmRunID)) {
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: orchestrator hit MAX_ORCHESTRATOR_REPLANS=${MAX_ORCHESTRATOR_REPLANS} — stopping ticker (replan-loop-exhausted)`,
    );
    stopAutoTicker(swarmRunID, 'replan-loop-exhausted');
    return;
  }

  state.lastSweepAtMs = Date.now();
  // `candidate` = what we'd escalate to naturally; `clampedNextTier`
  // is the bounded value used for the actual sweep. At MAX_TIER the
  // two diverge — candidate might be 6 but we re-sweep at 5 again
  // (Stage 2 MAX_TIER continuity — user's 2026-04-24 precedence call).
  const candidate = state.currentTier + 1;
  const clampedNextTier = Math.min(candidate, MAX_TIER);
  const tierLabel =
    TIER_LADDER.find((t) => t.tier === clampedNextTier)?.name ?? `Tier ${clampedNextTier}`;
  try {
    if (clampedNextTier === state.currentTier) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: at MAX_TIER=${MAX_TIER} — re-sweeping at tier ${MAX_TIER} instead of escalating. Run continues until a hard cap or manual stop.`,
      );
    }
    console.log(
      `[board/auto-ticker] ${swarmRunID}: attempting tier escalation ${state.currentTier} → ${clampedNextTier} (${tierLabel})`,
    );
    // Stage 2 audit: run a pre-escalation audit so the next sweep's
    // prompt context carries fresh verdicts (criteriaSummaries surface
    // MET / UNMET / WONT_DO tags). Await it — the verdicts are an
    // input to the tier-N+1 planner prompt; firing asynchronously
    // would let the sweep run without them.
    await maybeRunAudit(state, 'tier-escalation');

    const beforeOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    // overwrite: true so the "board already populated" guard in the
    // planner doesn't throw — the board intentionally has items at this
    // point (the drained initial batch). includeBoardContext: true so
    // the planner sees what's already done/pending and proposes new
    // work instead of duplicates. escalationTier routes to the tier-
    // aware prompt variant.
    const result = await livePlanner().runPlannerSweep(swarmRunID, {
      overwrite: true,
      includeBoardContext: true,
      escalationTier: clampedNextTier,
    });
    const afterOpen = listBoardItems(swarmRunID).filter(
      (i) => i.status === 'open',
    ).length;
    const newlyOpen = afterOpen - beforeOpen;
    if (newlyOpen > 0) {
      console.log(
        `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation seeded ${newlyOpen} new todo(s) — resetting idle counters`,
      );
      state.currentTier = clampedNextTier;
      for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
    } else {
      // This tier had nothing to propose. Before bumping or exhausting,
      // try cold-file seeding (PATTERN_DESIGN/stigmergy.md I3) — there
      // may be untouched workspace files the swarm hasn't explored.
      // If that seeds work, keep the run alive at the current tier.
      let coldSeeded = 0;
      try {
        coldSeeded = await attemptColdFileSeeding(swarmRunID);
      } catch (err) {
        console.warn(
          `[board/auto-ticker] ${swarmRunID}: cold-file seeding threw:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (coldSeeded > 0) {
        console.log(
          `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} produced no work but cold-file seeder added ${coldSeeded} exploration todo(s) — resetting idle counters`,
        );
        for (const slot of state.slots.values()) slot.consecutiveIdle = 0;
      } else {
        // No tier proposal AND no cold files left. Bump tier to retry
        // higher; at MAX_TIER mark exhausted so the next cascade stops.
        console.log(
          `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation produced no work (planner returned ${result.items.length} item(s) total); cold-file seeder also produced 0`,
        );
        state.currentTier = clampedNextTier;
        if (clampedNextTier >= MAX_TIER) {
          state.tierExhausted = true;
        }
      }
    }
    // Persist the new tier to meta.json so a ticker restart can resume
    // at the current tier instead of dropping back to 1. Fire-and-
    // forget: a failed write isn't worth stalling the ticker for, and
    // the next successful bump will overwrite anyway.
    void updateRunMeta(swarmRunID, { currentTier: state.currentTier }).catch(
      (err) => {
        console.warn(
          `[board/auto-ticker] ${swarmRunID}: tier persist failed:`,
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[board/auto-ticker] ${swarmRunID}: tier-${clampedNextTier} escalation threw:`,
      message,
    );
    // Don't bump tier on exception — a transient opencode / network error
    // shouldn't burn a tier. The idle cascade will retry on the next
    // tick-cycle subject to MIN_MS_BETWEEN_SWEEPS throttling.
  } finally {
    state.resweepInFlight = false;
  }
}
