// Orchestrator-worker pattern — pilot for the hierarchical branch
// re-opened 2026-04-23 (see DESIGN.md §1, ).
//
// Shape: N sessions under one run. Session 0 is the orchestrator — it
// owns the mission, plans the work, and re-strategizes mid-run.
// Sessions 1..N-1 are workers who claim + implement the orchestrator's
// todos off the shared blackboard.
//
// Why this over plain blackboard: a stable planner that owns the mission
// across sweeps produces more ambitious work than blackboard's
// per-sweep anonymous planner. The 2026-04-23 overnight run diagnosed
// this gap — blackboard's auto-planner produced competent-but-timid
// todos because nobody owned the mission the way a persistent
// orchestrator would.
//
// Machinery reuse: piggybacks on blackboard's board store, planner
// sweep, auto-ticker, zombie auto-abort, and liveness watchdog. The
// only new pieces are (a) the orchestrator-framed prompt posted to
// session 0 at run start, and (b) the auto-ticker's orchestrator
// exclusion which routes dispatch only to sessions 1..N-1.

import 'server-only';

import { postSessionMessageServer } from './opencode-server';
import { startAutoTicker } from './blackboard/auto-ticker';
import { runPlannerSweep } from './blackboard/planner';
import { getRun } from './swarm-registry';

// The name carried in opencode's `info.agent` for the planner session.
// Surfaces in the transform.ts-derived Agent so the roster shows a
// distinct "orchestrator" identity vs. the worker sessions. Workers
// keep the default name; their identity differentiation is only
// session-level (shown as session 1, 2, … in the board chips).
export const ORCHESTRATOR_AGENT_NAME = 'orchestrator';

function buildOrchestratorIntroPrompt(
  directive: string | undefined,
  workerCount: number,
): string {
  const base =
    directive?.trim() ||
    'Achieve the mission implied by the project README.';

  return [
    'You are the orchestrator of a team.',
    '',
    `Mission: ${base}`,
    '',
    `You have ${workerCount} worker session${workerCount === 1 ? '' : 's'} under you.`,
    'Workers will claim and implement each todo you produce via the shared',
    'blackboard. They trust your plan. Your authority is to decide:',
    '- What gets done, in what order',
    '- How the work decomposes into claimable units',
    '- When the team changes direction based on progress',
    '',
    'You are session 0 of the run. You will NOT claim worker todos yourself',
    '— your job is to plan, not to execute. Any work you schedule goes to',
    'the workers. You remain available through the run to re-strategize if',
    'the team hits blockers; humans can message you directly.',
    '',
    'Every ~20 minutes you will receive a re-planning prompt that includes',
    'the board state so far. Use it to re-examine coverage, flag gaps, and',
    'propose the next slice of work.',
    '',
    'Your first task: read the Mission above, examine the project (the',
    "project's README is embedded in the planner prompt that follows this",
    'message), and produce the initial plan via the todowrite tool.',
    '',
    'The planner prompt for this round is below. Follow its guidance for',
    'the initial sweep.',
  ].join('\n');
}

// Fire-and-forget kickoff called from POST /api/swarm/run. Runs in the
// background so the HTTP response returns before the orchestrator has
// produced anything. Failures log and exit quietly — the sessions
// still exist, and the human can manually re-prompt session 0 if the
// auto-kickoff fails.
export async function runOrchestratorWorkerKickoff(
  swarmRunID: string,
  opts: { persistentSweepMinutes?: number } = {},
): Promise<void> {
  const meta = await getRun(swarmRunID);
  if (!meta) {
    console.warn(
      `[orchestrator-worker] run ${swarmRunID} not found — kickoff aborted`,
    );
    return;
  }
  if (meta.pattern !== 'orchestrator-worker') {
    console.warn(
      `[orchestrator-worker] run ${swarmRunID} has pattern '${meta.pattern}', not orchestrator-worker — kickoff aborted`,
    );
    return;
  }
  if (meta.sessionIDs.length < 2) {
    console.warn(
      `[orchestrator-worker] run ${swarmRunID} has only ${meta.sessionIDs.length} session(s) — need at least 2 (1 orchestrator + 1 worker); kickoff aborted`,
    );
    return;
  }

  const orchestratorSessionID = meta.sessionIDs[0];
  const workerCount = meta.sessionIDs.length - 1;

  // Post the orchestrator-framing message. Pass agent='build' explicitly
  // so opencode includes tool definitions (the `task` tool especially —
  // that's how the orchestrator dispatches to worker sessions). Earlier
  // code passed `agent: 'orchestrator'` (silent-204'd by opencode since
  // 'orchestrator' isn't a built-in), then dropped the agent entirely
  // assuming opencode would default to 'build'. But empirical test on
  // 2026-04-27 (run_mohrfodp_xw8ht1) showed no-agent dispatch produces
  // text-only assistant turns — orchestrator generated 16 completed
  // turns / 631K tokens, never invoked the `task` tool, workers idle.
  // Same shape as the blackboard planner-sweep agent-drop bug; same fix.
  // 'build' is opencode's full-tool default agent; the `model` field
  // overrides build's configured default model so we still pin to the
  // user's teamModels[0] choice.
  const intro = buildOrchestratorIntroPrompt(meta.directive, workerCount);
  try {
    await postSessionMessageServer(
      orchestratorSessionID,
      meta.workspace,
      intro,
      { agent: 'build', model: meta.teamModels?.[0] },
    );
    console.log(
      `[orchestrator-worker] run ${swarmRunID}: orchestrator intro posted to ${orchestratorSessionID.slice(-8)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[orchestrator-worker] run ${swarmRunID}: orchestrator intro post failed:`,
      message,
    );
    return;
  }

  // Fire the initial planner sweep against the orchestrator session
  // (runPlannerSweep uses sessionIDs[0] by default — that's us).
  // The orchestrator has the README embedded and just got its role-
  // framing message; the planner prompt follows naturally.
  try {
    const result = await runPlannerSweep(swarmRunID);
    if (result.items.length === 0) {
      console.warn(
        `[orchestrator-worker] run ${swarmRunID}: initial planner sweep produced 0 todos — auto-ticker NOT started`,
      );
      return;
    }
    console.log(
      `[orchestrator-worker] run ${swarmRunID}: initial sweep produced ${result.items.length} todos — starting auto-ticker with worker-only dispatch`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[orchestrator-worker] run ${swarmRunID}: initial planner sweep failed:`,
      message,
    );
    return;
  }

  // Start the ticker with orchestratorSessionID excluded from dispatch.
  // Workers only — orchestrator stays reserved for planning + re-planning.
  const periodicSweepMs =
    opts.persistentSweepMinutes && opts.persistentSweepMinutes > 0
      ? Math.round(opts.persistentSweepMinutes * 60_000)
      : 0;
  startAutoTicker(swarmRunID, {
    periodicSweepMs,
    orchestratorSessionID,
  });
}
