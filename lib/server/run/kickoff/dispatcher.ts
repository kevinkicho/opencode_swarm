// HARDENING_PLAN.md#C2 — app/api/swarm/run/route.ts split.
//
// Pattern → kickoff function dispatch table. Replaces the 9-branch
// if-chain that was 142 LOC inline at app/api/swarm/run/route.ts:889-971.
// Each pattern's kickoff already lives in its own module
// (lib/server/{orchestrator-worker,role-differentiated,critic-loop,
// debate-judge,deliberate-execute,council,map-reduce}.ts) — this file
// is just the lookup that maps a pattern + parsed request to the right
// invocation.
//
// Why a function-returning table rather than a `Promise<unknown>`-
// keyed map: each kickoff has a different opts shape (criticMaxIterations
// for critic-loop, debateMaxRounds for debate-judge, persistentSweepMinutes
// for blackboard-style patterns). The closure here threads the right
// fields per pattern; callers see one uniform `(runID, parsed) => Promise`
// shape.

import 'server-only';

import { runCouncilRounds } from '../../council';
import { runMapReduceSynthesis } from '../../map-reduce';
import { runOrchestratorWorkerKickoff } from '../../orchestrator-worker';
import { runRoleDifferentiatedKickoff } from '../../role-differentiated';
import { runCriticLoopKickoff } from '../../critic-loop';
import { runDebateJudgeKickoff } from '../../debate-judge';
import { runDeliberateExecuteKickoff } from '../../deliberate-execute';
import type { SwarmRunRequest } from '../../../swarm-run-types';
import type { SwarmPattern } from '../../../swarm-types';

import { runBlackboardKickoff } from './blackboard';

/**
 * Per-pattern kickoff invocation. Returns null when the pattern has no
 * post-spawn kickoff (pattern='none' just spawns sessions and posts the
 * directive; nothing further). Otherwise the returned promise represents
 * the orchestrator's first awaitable — `raceKickoffSync` (R1) inspects it
 * for synchronous rejection so the route can return 5xx instead of 201
 * for runs whose orchestrator already crashed.
 */
export type KickoffInvocation =
  | { label: string; promise: Promise<unknown> }
  | null;

export function invokeKickoff(
  pattern: SwarmPattern,
  runID: string,
  parsed: SwarmRunRequest,
): KickoffInvocation {
  switch (pattern) {
    case 'none':
      return null;

    case 'blackboard':
      return {
        label: 'blackboard',
        promise: runBlackboardKickoff(runID, {
          persistentSweepMinutes: parsed.persistentSweepMinutes,
        }),
      };

    case 'map-reduce':
      return {
        label: 'map-reduce',
        promise: runMapReduceSynthesis(runID),
      };

    case 'council':
      return {
        label: 'council',
        promise: runCouncilRounds(runID),
      };

    case 'orchestrator-worker':
      return {
        label: 'orchestrator-worker',
        promise: runOrchestratorWorkerKickoff(runID, {
          persistentSweepMinutes: parsed.persistentSweepMinutes,
        }),
      };

    case 'role-differentiated':
      return {
        label: 'role-differentiated',
        promise: runRoleDifferentiatedKickoff(runID, {
          persistentSweepMinutes: parsed.persistentSweepMinutes,
        }),
      };

    case 'critic-loop':
      return {
        label: 'critic-loop',
        promise: runCriticLoopKickoff(runID, {
          maxIterations: parsed.criticMaxIterations,
        }),
      };

    case 'debate-judge':
      return {
        label: 'debate-judge',
        promise: runDebateJudgeKickoff(runID, {
          maxRounds: parsed.debateMaxRounds,
        }),
      };

    case 'deliberate-execute':
      return {
        label: 'deliberate-execute',
        promise: runDeliberateExecuteKickoff(runID, {
          persistentSweepMinutes: parsed.persistentSweepMinutes,
        }),
      };
  }
}
