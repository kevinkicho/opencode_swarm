// Pipeline coordinator — chains existing patterns into a multi-phase
// workflow. Each phase is a standalone swarm run created via the POST
// /api/swarm/run route, linked via continuationOf so the UI renders
// them as a chain with aggregate cost/tokens.
//
// Shape: the pipeline itself is a thin watcher session (1 opencode
// session). The kickoff creates phase-1 immediately, then polls for
// completion. When phase-1 reaches a terminal status (idle/stale), it
// synthesizes the output into a directive for phase-2 and creates that
// run — and so on until all phases complete or a phase fails.
//
// Output synthesis between phases uses the memory store's per-run retro
// (lessons + artifacts) combined with any board items (findings, done
// todos). The synthesized directive carries forward:
//   1. The original user directive (always)
//   2. Key findings / lessons from the prior phase
//   3. An explicit handoff instruction ("This is phase N of M. Phase
//      N-1 completed. Your mission: ...")
//
// Why continuationOf instead of sub-runs: each phase is a fully
// independent run with its own swarmRunID, sessions, and orchestrator.
// This means:
//   - Phase failures are isolated (a failed explore phase doesn't
//     prevent the execute phase from starting manually)
//   - The UI already renders chains (repo-runs-view builds Chain
//     objects from continuationOf pointers)
//   - Each phase can use a different teamSize and pattern
//   - The memory store writes lessons per-workspace, so phase-2
//     automatically sees phase-1's lessons in its intro directive
//
// Stop conditions:
//   - All phases complete successfully → done
//   - A phase reaches 'error' status → abort, record partial outcome
//   - Wall-clock cap exceeded → abort, record partial outcome
//   - A phase's orchestrator rejects the kickoff (sync reject) → abort

import 'server-only';

import { resolvePipelinePhases, patternDefaults } from '../swarm-patterns';
import { checkWallClockExpired } from './swarm-bounds';
import { withRunGuard } from './run-guard';
import { getRun } from './swarm-registry';
import type {
  SwarmRunMeta,
  SwarmRunRequest,
  PipelineConfig,
  PipelinePhase,
} from '../swarm-run-types';
import type { SwarmPattern } from '../swarm-types';

// How often the pipeline polls for phase completion. Long enough to
// avoid hammering the registry; short enough that phase transitions
// feel responsive.
const PHASE_POLL_INTERVAL_MS = 5000;

// Terminal statuses that mean a phase has finished (successfully or not).
const TERMINAL_STATUSES = new Set(['idle', 'stale', 'error']);

// Maximum time to wait for a single phase before declaring it stuck.
const PHASE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// Build the SwarmRunRequest for a phase run. Inherits workspace and
// source from the pipeline's meta. Phase-specific directive overrides
// the original; otherwise the original directive carries forward.
function buildPhaseRequest(
  pipelineMeta: SwarmRunMeta,
  phase: PipelinePhase,
  phaseDirective: string,
  priorRunID: string | null,
): SwarmRunRequest {
  const defaults = patternDefaults[phase.pattern];
  const teamSize = phase.teamSize ?? PATTERN_TEAM_SIZE_DEFAULTS[phase.pattern];
  return {
    pattern: phase.pattern,
    workspace: phase.workspace ?? pipelineMeta.workspace,
    source: pipelineMeta.source,
    directive: phaseDirective,
    title: pipelineMeta.title
      ? `${pipelineMeta.title} · ${phase.pattern}`
      : undefined,
    teamSize,
    bounds: pipelineMeta.bounds,
    continuationOf: priorRunID ?? pipelineMeta.swarmRunID,
    teamModels: defaults.teamModels?.(teamSize),
    ...(defaults.criticModel ? { criticModel: defaults.criticModel } : {}),
    ...(defaults.verifierModel ? { verifierModel: defaults.verifierModel } : {}),
    ...(defaults.auditorModel ? { auditorModel: defaults.auditorModel } : {}),
    ...(defaults.synthesisModel ? { synthesisModel: defaults.synthesisModel } : {}),
    ...(defaults.enableAuditorGate ? { enableAuditorGate: true } : {}),
    ...(phase.pattern === 'council' ? { autoStopOnConverge: true } : {}),
    ...(phase.pattern === 'map-reduce' ? { enableSynthesisCritic: true } : {}),
  };
}

// Default team sizes per pattern — used when a phase omits teamSize.
const PATTERN_TEAM_SIZE_DEFAULTS: Record<SwarmPattern, number> = {
  none: 1,
  blackboard: 3,
  'map-reduce': 3,
  council: 3,
  'orchestrator-worker': 4,
  'debate-judge': 4,
  'critic-loop': 2,
  pipeline: 1,
};

// Synthesize a directive for the next phase from the prior phase's
// output. Reads the memory store for lessons + reads board items for
// findings, and combines them with a handoff instruction.
async function synthesizePhaseDirective(
  phaseIndex: number,
  totalPhases: number,
  originalDirective: string | undefined,
  priorMeta: SwarmRunMeta,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`[Pipeline phase ${phaseIndex + 1} of ${totalPhases}]`);
  parts.push('');

  if (originalDirective) {
    parts.push('Original mission:');
    parts.push(originalDirective);
    parts.push('');
  }

  // Board items — findings and completed todos from the prior phase.
  try {
    const { listBoardItems } = await import('./blackboard/store');
    const items = listBoardItems(priorMeta.swarmRunID);
    const findings = items.filter(
      (i) => i.kind === 'finding' && i.status === 'done',
    );
    const completedTodos = items.filter(
      (i) => i.kind === 'todo' && i.status === 'done',
    );
    const staleTodos = items.filter(
      (i) => i.kind === 'todo' && i.status === 'stale',
    );

    if (completedTodos.length > 0) {
      parts.push(`Completed tasks from prior phase (${completedTodos.length}):`);
      for (const t of completedTodos.slice(0, 10)) {
        parts.push(`  - ${t.content.slice(0, 120)}`);
      }
      parts.push('');
    }
    if (staleTodos.length > 0) {
      parts.push(`Unresolved items from prior phase (${staleTodos.length}):`);
      for (const t of staleTodos.slice(0, 5)) {
        parts.push(`  - ${t.content.slice(0, 120)}`);
      }
      parts.push('');
    }
    if (findings.length > 0) {
      parts.push(`Key findings from prior phase (${findings.length}):`);
      for (const f of findings.slice(0, 8)) {
        parts.push(`  - ${f.content.slice(0, 200)}`);
      }
      parts.push('');
    }
  } catch {
    console.warn('[pipeline] board item read failed — continuing without prior findings');
  }

  // Memory lessons from the workspace (includes prior phase's retro).
  try {
    const { readRecentMemory, renderMemoryForSeed } = await import(
      './memory/memory-store'
    );
    const entries = await readRecentMemory(priorMeta.workspace);
    if (entries.length > 0) {
      const memoryText = renderMemoryForSeed(entries);
      if (memoryText) {
        parts.push('Lessons from prior runs:');
        parts.push(memoryText);
        parts.push('');
      }
    }
  } catch {
    console.warn('[pipeline] memory read failed — continuing without lessons');
  }

  // Phase-appropriate handoff instruction.
  const phase = phaseIndex; // 0-indexed
  if (phase === 0) {
    parts.push(
      'This is the first phase. Explore broadly, generate options, and surface findings.',
    );
  } else if (phase < totalPhases - 1) {
    parts.push(
      'This is a middle phase. Build on the prior phase findings — deliberate, filter, and refine.',
    );
  } else {
    parts.push(
      'This is the final phase. Execute on the best approach identified by prior phases. Ship working code.',
    );
  }

  return parts.join('\n');
}

// Poll a run's status until it reaches a terminal state or times out.
// Returns the final meta or null on timeout.
async function waitForPhaseCompletion(
  swarmRunID: string,
): Promise<SwarmRunMeta | null> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const meta = await getRun(swarmRunID);
    if (!meta) return null;
    // Derive status by checking if the run's sessions are idle/stale.
    // For the pipeline coordinator we just check the meta — the auto-
    // ticker and non-ticker orchestrators update status on completion.
    // A run whose sessions have completed will have board items in done
    // state and its orchestrator will have exited. For our purposes, we
    // check if the run is past a reasonable age and has been idle for
    // long enough. But the simplest check: does the run have a stale/
    // error finding from recordPartialOutcome? Or is the auto-ticker
    // stopped?
    //
    // For now, we use a simpler heuristic: poll the run's sessions
    // until all are idle. The derive module would be expensive to call
    // per-poll; instead we look at board items as a progress signal.
    //
    // Phase completion detection: a phase is complete when:
    //   1. The board (blackboard-family) has no 'open' or 'in-progress' items
    //   2. The run was created more than 30s ago (minimum phase duration)
    //   3. The meta has been stable for PHASE_POLL_INTERVAL_MS
    //
    // For non-blackboard patterns (council, debate-judge, critic-loop,
    // map-reduce), completion is signaled by the finding that
    // recordPartialOutcome writes.
    //
    // Simplest approach: check if any finding exists with status='done'
    // that was written AFTER the run's createdAt — that means the
    // orchestrator wrote a completion record.
    const age = Date.now() - meta.createdAt;
    if (age < 30_000) {
      // Too young to be done — keep polling.
      await new Promise((r) => setTimeout(r, PHASE_POLL_INTERVAL_MS));
      continue;
    }

    try {
      const { listBoardItems } = await import('./blackboard/store');
      const items = listBoardItems(swarmRunID);
      const openItems = items.filter(
        (i) => i.status === 'open' || i.status === 'claimed' || i.status === 'in-progress',
      );
      const hasCompletionFinding = items.some(
        (i) => i.kind === 'finding' && i.status === 'done' && i.createdAtMs > meta.createdAt,
      );

      // Blackboard-family patterns: complete when no open items remain
      // and the run has been alive for at least 30s.
      if (
        meta.pattern === 'blackboard' ||
        meta.pattern === 'orchestrator-worker'
      ) {
        if (openItems.length === 0 && items.length > 0) {
          return meta;
        }
      }

      // All patterns write a completion finding on success (via
      // recordPartialOutcome for non-ticker patterns, or the auto-
      // ticker's stop logic for blackboard-family).
      if (hasCompletionFinding) {
        return meta;
      }
    } catch {
      console.warn('[pipeline] board poll failed — continuing to wait');
    }

    await new Promise((r) => setTimeout(r, PHASE_POLL_INTERVAL_MS));
  }
  return null; // timeout
}

export async function runPipelineKickoff(
  swarmRunID: string,
  opts: { pipelineConfig: PipelineConfig } = { pipelineConfig: { preset: 'explore-then-execute' } },
): Promise<void> {
  await withRunGuard(
    swarmRunID,
    { expectedPattern: 'pipeline', context: 'pipeline' },
    async (meta) => {
      const phases = resolvePipelinePhases(opts.pipelineConfig);
      const totalPhases = phases.length;

      console.log(
        `[pipeline] run ${swarmRunID}: starting ${totalPhases}-phase pipeline (${phases.map((p) => p.pattern).join(' → ')})`,
      );

      let priorRunID: string | null = null;
      let priorMeta: SwarmRunMeta | null = null;

      for (let i = 0; i < totalPhases; i += 1) {
        const phase = phases[i];

        // Wall-clock cap check before each phase.
        if (checkWallClockExpired(swarmRunID, meta, `phase ${i + 1}/${totalPhases}`, `Pipeline aborted before phase ${i + 1}.`)) {
          return;
        }

        // Build the directive for this phase.
        let directive: string;
        if (i === 0) {
          directive =
            phase.directive ??
            meta.directive ??
            'Explore the codebase and surface findings.';
        } else {
          directive =
            phase.directive ??
            (await synthesizePhaseDirective(
              i,
              totalPhases,
              meta.directive,
              priorMeta!,
            ));
        }

        // Create the phase run via the internal route handler. We call
        // the same createRun + invokeKickoff flow, but directly
        // instead of via HTTP (avoids network round-trip + auth).
        const phaseReq = buildPhaseRequest(meta, phase, directive, priorRunID);

        console.log(
          `[pipeline] run ${swarmRunID}: creating phase ${i + 1} (${phase.pattern}, teamSize=${phaseReq.teamSize ?? 'default'})`,
        );

        // Import the route handler's creation flow. We need sessions
        // for the phase run — create them directly via opencode.
        const { createSessionServer } = await import('./opencode-server');
        const { createRun } = await import('./swarm-registry');
        const { invokeKickoff } = await import('./run/kickoff/dispatcher');
        const { raceKickoffSync, attachLateFailureLog } = await import(
          './run/kickoff-guard'
        );
        const { dispatchInitialDirective } = await import(
          './run/dispatch-intro'
        );
        const { spawnGateSessions } = await import('./run/spawn-gates');
        const { collectOllamaModels, prewarmModels } = await import(
          './blackboard/model-prewarm'
        );
        const { teamSizeWarningMessage } = await import('../swarm-patterns');

        const phaseTeamSize =
          phaseReq.teamSize ??
          PATTERN_TEAM_SIZE_DEFAULTS[phase.pattern];
        const phaseDefaults = patternDefaults[phase.pattern];
        if (phaseDefaults.teamModels && !phaseReq.teamModels) {
          phaseReq.teamModels = phaseDefaults.teamModels(phaseTeamSize);
        }
        if (phaseDefaults.criticModel && !phaseReq.criticModel) {
          phaseReq.criticModel = phaseDefaults.criticModel;
        }
        if (phaseDefaults.verifierModel && !phaseReq.verifierModel) {
          phaseReq.verifierModel = phaseDefaults.verifierModel;
        }
        if (phaseDefaults.auditorModel && !phaseReq.auditorModel) {
          phaseReq.auditorModel = phaseDefaults.auditorModel;
        }
        if (
          phaseDefaults.enableAuditorGate !== undefined &&
          phaseReq.enableAuditorGate === undefined
        ) {
          phaseReq.enableAuditorGate = phaseDefaults.enableAuditorGate;
        }
        if (phaseDefaults.synthesisModel && !phaseReq.synthesisModel) {
          phaseReq.synthesisModel = phaseDefaults.synthesisModel;
        }

        const phaseSanityWarn = teamSizeWarningMessage(
          phase.pattern,
          phaseTeamSize,
        );
        if (phaseSanityWarn) console.warn(phaseSanityWarn);

        const warmPromise = prewarmModels(collectOllamaModels(phaseReq));

        const seedTitle = phaseReq.title ?? phaseReq.directive?.split('\n', 1)[0]?.trim();
        const titleFor = (idx: number): string | undefined => {
          if (!seedTitle) return undefined;
          return phaseTeamSize > 1 ? `${seedTitle} #${idx + 1}` : seedTitle;
        };

        const spawnResults = await Promise.allSettled(
          Array.from({ length: phaseTeamSize }, (_, idx) =>
            createSessionServer(phaseReq.workspace, titleFor(idx)),
          ),
        );

        const sessions = spawnResults
          .map((r, idx) => ({ result: r, idx }))
          .filter(({ result }) => result.status === 'fulfilled')
          .map(({ result, idx }) => ({
            id: (result as PromiseFulfilledResult<{ id: string }>).value.id,
            idx,
          }));

        if (sessions.length === 0) {
          console.error(
            `[pipeline] run ${swarmRunID}: phase ${i + 1} (${phase.pattern}) failed — 0 sessions spawned`,
          );
          const { recordPartialOutcome } = await import('./degraded-completion');
          recordPartialOutcome(swarmRunID, {
            pattern: 'pipeline',
            phase: `phase ${i + 1}/${totalPhases} session-spawn`,
            reason: 'zero-sessions',
            summary: `Phase ${i + 1} (${phase.pattern}) failed to spawn any opencode sessions. Pipeline aborted.`,
          });
          return;
        }

        await warmPromise.catch((err) => {
          console.warn(
            `[pipeline] model pre-warm failed (continuing):`,
            err instanceof Error ? err.message : String(err),
          );
        });

        await dispatchInitialDirective(phaseReq, sessions);

        const {
          criticSessionID,
          verifierSessionID,
          auditorSessionID,
          failures: gateFailures,
        } = await spawnGateSessions(phaseReq, seedTitle);

        if (Object.keys(gateFailures).length > 0) {
          console.warn(
            `[pipeline] run ${swarmRunID}: phase ${i + 1} gate failures:`,
            JSON.stringify(gateFailures),
          );
        }

        const sessionIDs = sessions.map((s) => s.id);
        const teamModelsSurvivors = phaseReq.teamModels
          ? sessions.map((s) => phaseReq.teamModels![s.idx])
          : undefined;

        const phaseRunMeta = await createRun(phaseReq, sessionIDs, {
          criticSessionID,
          verifierSessionID,
          auditorSessionID,
          teamModels: teamModelsSurvivors,
        });

        // Kick off the phase's orchestrator.
        const kickoff = invokeKickoff(phase.pattern, phaseRunMeta.swarmRunID, phaseReq);

        if (kickoff) {
          const sync = await raceKickoffSync(kickoff.promise);
          if (sync.kind === 'rejected') {
            console.error(
              `[pipeline] run ${swarmRunID}: phase ${i + 1} (${phase.pattern}) kickoff rejected: ${sync.error.message}`,
            );
            const { recordPartialOutcome } = await import('./degraded-completion');
            recordPartialOutcome(swarmRunID, {
              pattern: 'pipeline',
              phase: `phase ${i + 1}/${totalPhases} kickoff`,
              reason: 'kickoff-rejected',
              summary: `Phase ${i + 1} (${phase.pattern}) kickoff failed: ${sync.error.message}. Pipeline aborted.`,
            });
            return;
          }
          if (sync.kind === 'pending') {
            attachLateFailureLog(kickoff.promise, kickoff.label, phaseRunMeta.swarmRunID);
          }
        }

        console.log(
          `[pipeline] run ${swarmRunID}: phase ${i + 1} (${phase.pattern}) launched as run ${phaseRunMeta.swarmRunID}`,
        );

        // Wait for the phase to complete.
        const completedMeta = await waitForPhaseCompletion(
          phaseRunMeta.swarmRunID,
        );

        if (!completedMeta) {
          console.warn(
            `[pipeline] run ${swarmRunID}: phase ${i + 1} (${phase.pattern}) timed out after ${PHASE_TIMEOUT_MS / 60_000}min`,
          );
          const { recordPartialOutcome } = await import('./degraded-completion');
          recordPartialOutcome(swarmRunID, {
            pattern: 'pipeline',
            phase: `phase ${i + 1}/${totalPhases} timeout`,
            reason: 'phase-timeout',
            summary: `Phase ${i + 1} (${phase.pattern}, run ${phaseRunMeta.swarmRunID}) timed out after ${PHASE_TIMEOUT_MS / 60_000} minutes. Pipeline aborted.`,
          });
          return;
        }

        console.log(
          `[pipeline] run ${swarmRunID}: phase ${i + 1} (${phase.pattern}) completed`,
        );

        priorRunID = phaseRunMeta.swarmRunID;
        priorMeta = completedMeta;
      }

      console.log(
        `[pipeline] run ${swarmRunID}: all ${totalPhases} phases completed`,
      );
    },
  );
}