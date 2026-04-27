//
// Initial-directive dispatch — posts the user's directive to every
// surviving session in parallel as the run's first turn. Two shapes:
//
//   - map-reduce  → derive workspace slices and decorate each session's
//     directive with its scope ("your slice: src/api/"). Slices come
//     from a shallow read of top-level dirs; imbalance > 5x logs a WARN.
//   - all others  → uniform directive across surviving sessions.
//
// Patterns with custom intros (blackboard / orchestrator-worker /
// debate-judge / critic-loop) skip this branch entirely — their
// kickoff modules post pattern-specific intros instead.
//
// Per-session post failures log and continue. The session exists, the
// composer can re-fire the prompt, and one slow member shouldn't stall
// the fast ones.

import 'server-only';

import { postSessionMessageServer } from '../opencode-server';
import {
  buildScopedDirective,
  deriveSlices,
  detectScopeImbalance,
} from '../map-reduce';
import type { SwarmRunRequest } from '../../swarm-run-types';
import type { SwarmPattern } from '../../swarm-types';

const PATTERNS_WITH_CUSTOM_INTRO: ReadonlySet<SwarmPattern> = new Set([
  'blackboard',
  'orchestrator-worker',
  'debate-judge',
  'critic-loop',
]);

interface SessionSlot {
  id: string;
  /** Index in the original spawn slot — used to pick the right teamModels[i]. */
  idx: number;
}

export async function dispatchInitialDirective(
  parsed: SwarmRunRequest,
  sessions: readonly SessionSlot[],
): Promise<void> {
  if (PATTERNS_WITH_CUSTOM_INTRO.has(parsed.pattern)) return;
  if (!parsed.directive || !parsed.directive.trim()) return;

  const directive = parsed.directive;
  let directives: string[];

  if (parsed.pattern === 'map-reduce') {
    const slices = await deriveSlices(parsed.workspace, sessions.length);
    directives = sessions.map((_, i) =>
      buildScopedDirective(directive, slices[i], i, sessions.length),
    );
    // Fire-and-forget: walks the slice dirs to detect >5x imbalance.
    // Non-blocking — kickoff doesn't wait, the WARN just lands in logs
    // a few hundred ms later for the operator to notice.
    detectScopeImbalance(parsed.workspace, slices).catch((err) => {
      console.warn(
        `[swarm/run] scope imbalance check failed:`,
        err instanceof Error ? err.message : String(err),
      );
    });
  } else {
    directives = sessions.map(() => directive);
  }

  // Team-model pinning for the first directive. The `sessions[i].idx`
  // indexes into the ORIGINAL teamModels array (pre-survivor-filter)
  // — reindex here so session `s` gets its originally-picked model
  // even after partial spawn failures. Undefined → opencode default.
  const postResults = await Promise.allSettled(
    sessions.map((s, i) =>
      postSessionMessageServer(s.id, parsed.workspace, directives[i], {
        model: parsed.teamModels?.[s.idx],
      }),
    ),
  );
  postResults.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(
        `[swarm/run] directive post failed for session ${sessions[i].id}:`,
        r.reason instanceof Error ? r.reason.message : String(r.reason),
      );
    }
  });
}
