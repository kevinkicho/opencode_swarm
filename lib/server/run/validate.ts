//
// Request-body validator for POST /api/swarm/run. Returns either a
// fully-typed SwarmRunRequest or a string describing the first problem
// (the route maps that to a 400 response). Pure — no I/O. Pattern-
// specific table data (PATTERN_TEAM_SIZE, SUPPORTED_PATTERNS) lives
// here too because it's only consumed during validation.
//
// Pre-extraction this lived inline at app/api/swarm/run/route.ts as a
// 287-line parseRequest plus helper tables. Lifting it here lets the
// route file thin down to a thin POST/GET handler.

import 'server-only';

import type { SwarmRunRequest } from '../../swarm-run-types';
import type { SwarmPattern } from '../../swarm-types';

// Hard cap on multi-session fan-out. Picked to stay well inside opencode's
// parallel-prompt tolerance on the hosted Zen tier (probe margins, not a
// hard SDK limit). If a pattern legitimately needs more, raise this after
// measuring burst behavior — don't bypass it silently.
export const TEAM_SIZE_MAX = 8;

export const SUPPORTED_PATTERNS: ReadonlySet<SwarmPattern> = new Set([
  'none',
  'council',
  'blackboard',
  'map-reduce',
  'orchestrator-worker',
  'role-differentiated',
  'debate-judge',
  'critic-loop',
]);

// Pattern-specific defaults + floors. Encoded as a table so new patterns
// opt in by adding a row, not by branching the validator:
//   - `defaultSize`  is applied when the request omits teamSize
//   - `minSize` / `maxSize` clamp what the body is allowed to carry
// Patterns not in this table fall back to single-session (pattern='none'
// shape) so unsupported presets still get sensible defaults if they ever
// slip past SUPPORTED_PATTERNS.
export const PATTERN_TEAM_SIZE: Record<
  SwarmPattern,
  { defaultSize: number; minSize: number; maxSize: number }
> = {
  none: { defaultSize: 1, minSize: 1, maxSize: 1 },
  council: { defaultSize: 3, minSize: 2, maxSize: TEAM_SIZE_MAX },
  blackboard: { defaultSize: 3, minSize: 2, maxSize: TEAM_SIZE_MAX },
  // Map-reduce: minSize 3 enforces meaningful parallelism. With
  // teamSize=2, deriveSlices would hand each session a single dir
  // (or one dir + whole-workspace fallback) and the synth would
  // merge two near-identical analyses — basically running solo
  // twice. ollama-swarm sibling app (#109) found the same: bumped
  // their min mapper count to 3 mappers + 1 synth = 4 sessions.
  // Our model is more efficient since any session can claim the
  // synth (no dedicated synth slot), so 3 sessions = 3 mappers
  // with one of them taking the synth claim — minimum useful.
  'map-reduce': { defaultSize: 3, minSize: 3, maxSize: TEAM_SIZE_MAX },
  // Orchestrator-worker: 1 orchestrator + at least 1 worker = minSize 2.
  'orchestrator-worker': {
    defaultSize: 4,
    minSize: 2,
    maxSize: TEAM_SIZE_MAX,
  },
  // Role-differentiated: N workers with pinned roles. Default 4 gives
  // the planner room to distribute todos across architect/impl/test/review.
  'role-differentiated': {
    defaultSize: 4,
    minSize: 2,
    maxSize: TEAM_SIZE_MAX,
  },
  // Debate+judge: 1 judge + at least 2 generators = minSize 3.
  'debate-judge': {
    defaultSize: 4,
    minSize: 3,
    maxSize: TEAM_SIZE_MAX,
  },
  // Critic loop: exactly 2 parties (1 worker + 1 critic). Larger teams
  // don't map cleanly onto this shape — critic specialization assumes a
  // stable single reviewer.
  'critic-loop': {
    defaultSize: 2,
    minSize: 2,
    maxSize: 2,
  },
};

function isSwarmPattern(value: unknown): value is SwarmPattern {
  return (
    value === 'none' ||
    value === 'blackboard' ||
    value === 'map-reduce' ||
    value === 'council' ||
    value === 'orchestrator-worker' ||
    value === 'role-differentiated' ||
    value === 'debate-judge' ||
    value === 'critic-loop'
  );
}

// Pulls a validated SwarmRunRequest out of the raw JSON body. Returns a
// string describing the first problem rather than throwing — the route
// translates that into a 400 with a human-readable detail.
export function parseRequest(raw: unknown): SwarmRunRequest | string {
  if (!raw || typeof raw !== 'object') return 'body must be a JSON object';
  const obj = raw as Record<string, unknown>;

  if (!isSwarmPattern(obj.pattern)) return 'pattern must be one of: none, blackboard, map-reduce, council, orchestrator-worker, role-differentiated, debate-judge, critic-loop';

  // continuationOf: validate type explicitly so a bogus value (number,
  // array, etc.) rejects rather than silently degrading to a fresh run.
  if (obj.continuationOf !== undefined) {
    if (typeof obj.continuationOf !== 'string' || !obj.continuationOf.trim()) {
      return 'continuationOf, when provided, must be a non-empty swarmRunID string';
    }
  }
  // workspace is normally required, but when continuationOf is set we
  // allow it to be absent — resolveContinuation() fills it from the
  // prior run's meta. Still validated as a non-empty string when present.
  const hasContinuation =
    typeof obj.continuationOf === 'string' && obj.continuationOf.trim().length > 0;
  if (!hasContinuation) {
    if (typeof obj.workspace !== 'string' || !obj.workspace.trim()) {
      return 'workspace (absolute path) is required';
    }
  } else if (
    obj.workspace !== undefined &&
    (typeof obj.workspace !== 'string' || !obj.workspace.trim())
  ) {
    return 'workspace, when provided, must be a non-empty string';
  }

  const req: SwarmRunRequest = {
    pattern: obj.pattern,
    // Placeholder when continuation inheritance will fill workspace.
    // resolveContinuation() below will replace this before createRun.
    workspace: typeof obj.workspace === 'string' ? obj.workspace : '',
  };

  if (hasContinuation) {
    req.continuationOf = (obj.continuationOf as string).trim();
  }

  if (obj.source !== undefined) {
    if (typeof obj.source !== 'string') return 'source must be a string';
    req.source = obj.source;
  }
  if (obj.directive !== undefined) {
    if (typeof obj.directive !== 'string') return 'directive must be a string';
    req.directive = obj.directive;
  }
  if (obj.title !== undefined) {
    if (typeof obj.title !== 'string') return 'title must be a string';
    req.title = obj.title;
  }
  if (obj.teamSize !== undefined) {
    if (
      typeof obj.teamSize !== 'number' ||
      !Number.isFinite(obj.teamSize) ||
      !Number.isInteger(obj.teamSize)
    ) {
      return 'teamSize must be an integer';
    }
    const limits = PATTERN_TEAM_SIZE[req.pattern];
    if (obj.teamSize < limits.minSize || obj.teamSize > limits.maxSize) {
      return `teamSize for pattern '${req.pattern}' must be between ${limits.minSize} and ${limits.maxSize} (inclusive)`;
    }
    req.teamSize = obj.teamSize;
  }
  if (obj.bounds !== undefined) {
    if (!obj.bounds || typeof obj.bounds !== 'object') return 'bounds must be an object';
    const b = obj.bounds as Record<string, unknown>;
    const bounds: {
      costCap?: number;
      minutesCap?: number;
      commitsCap?: number;
      todosCap?: number;
    } = {};
    if (b.costCap !== undefined) {
      if (typeof b.costCap !== 'number' || !Number.isFinite(b.costCap)) {
        return 'bounds.costCap must be a finite number';
      }
      bounds.costCap = b.costCap;
    }
    if (b.minutesCap !== undefined) {
      if (typeof b.minutesCap !== 'number' || !Number.isFinite(b.minutesCap)) {
        return 'bounds.minutesCap must be a finite number';
      }
      bounds.minutesCap = b.minutesCap;
    }
    if (b.commitsCap !== undefined) {
      if (
        typeof b.commitsCap !== 'number' ||
        !Number.isFinite(b.commitsCap) ||
        !Number.isInteger(b.commitsCap) ||
        b.commitsCap < 1
      ) {
        return 'bounds.commitsCap must be a positive integer';
      }
      bounds.commitsCap = b.commitsCap;
    }
    if (b.todosCap !== undefined) {
      if (
        typeof b.todosCap !== 'number' ||
        !Number.isFinite(b.todosCap) ||
        !Number.isInteger(b.todosCap) ||
        b.todosCap < 1
      ) {
        return 'bounds.todosCap must be a positive integer';
      }
      bounds.todosCap = b.todosCap;
    }
    req.bounds = bounds;
  }

  if (obj.persistentSweepMinutes !== undefined) {
    if (
      typeof obj.persistentSweepMinutes !== 'number' ||
      !Number.isFinite(obj.persistentSweepMinutes) ||
      obj.persistentSweepMinutes < 0
    ) {
      return 'persistentSweepMinutes must be a non-negative finite number';
    }
    if (
      req.pattern !== 'blackboard' &&
      req.pattern !== 'orchestrator-worker' &&
      req.pattern !== 'role-differentiated' &&
      obj.persistentSweepMinutes > 0
    ) {
      return `persistentSweepMinutes only applies to patterns with blackboard-style execution (got '${req.pattern}')`;
    }
    req.persistentSweepMinutes = obj.persistentSweepMinutes;
  }

  if (obj.teamRoles !== undefined) {
    if (
      !Array.isArray(obj.teamRoles) ||
      obj.teamRoles.some((r) => typeof r !== 'string' || !r.trim())
    ) {
      return 'teamRoles must be an array of non-empty strings';
    }
    if (req.pattern !== 'role-differentiated') {
      return `teamRoles only applies to pattern='role-differentiated' (got '${req.pattern}')`;
    }
    req.teamRoles = (obj.teamRoles as string[]).map((r) => r.trim());
  }

  if (obj.teamModels !== undefined) {
    if (
      !Array.isArray(obj.teamModels) ||
      obj.teamModels.some((m) => typeof m !== 'string' || !m.trim())
    ) {
      return 'teamModels must be an array of non-empty model-ID strings';
    }
    // Length check happens after teamSize is resolved later — we push
    // it to a post-parse check there because teamSize defaults depend
    // on the pattern. Any-pattern-allowed: the `agent` override path
    // (role-differentiated) still wins at dispatch time if set, so
    // teamModels is additive.
    req.teamModels = (obj.teamModels as string[]).map((m) => m.trim());
  }

  if (obj.criticMaxIterations !== undefined) {
    if (
      typeof obj.criticMaxIterations !== 'number' ||
      !Number.isInteger(obj.criticMaxIterations) ||
      obj.criticMaxIterations < 1 ||
      obj.criticMaxIterations > 10
    ) {
      return 'criticMaxIterations must be an integer between 1 and 10';
    }
    if (req.pattern !== 'critic-loop') {
      return `criticMaxIterations only applies to pattern='critic-loop' (got '${req.pattern}')`;
    }
    req.criticMaxIterations = obj.criticMaxIterations;
  }

  if (obj.debateMaxRounds !== undefined) {
    if (
      typeof obj.debateMaxRounds !== 'number' ||
      !Number.isInteger(obj.debateMaxRounds) ||
      obj.debateMaxRounds < 1 ||
      obj.debateMaxRounds > 5
    ) {
      return 'debateMaxRounds must be an integer between 1 and 5';
    }
    if (req.pattern !== 'debate-judge') {
      return `debateMaxRounds only applies to pattern='debate-judge' (got '${req.pattern}')`;
    }
    req.debateMaxRounds = obj.debateMaxRounds;
  }

  if (obj.enableCriticGate !== undefined) {
    if (typeof obj.enableCriticGate !== 'boolean') {
      return 'enableCriticGate must be boolean';
    }
    // Only patterns that route commits through the blackboard coordinator
    // can use this gate — other patterns (council, map-reduce, debate-
    // judge, critic-loop) have their own orchestrators that bypass the
    // coordinator's done-transition path.
    if (
      obj.enableCriticGate === true &&
      req.pattern !== 'blackboard' &&
      req.pattern !== 'orchestrator-worker' &&
      req.pattern !== 'role-differentiated'
    ) {
      return `enableCriticGate only applies to blackboard-family patterns (got '${req.pattern}')`;
    }
    req.enableCriticGate = obj.enableCriticGate;
  }

  if (obj.enableVerifierGate !== undefined) {
    if (typeof obj.enableVerifierGate !== 'boolean') {
      return 'enableVerifierGate must be boolean';
    }
    if (
      obj.enableVerifierGate === true &&
      req.pattern !== 'blackboard' &&
      req.pattern !== 'orchestrator-worker' &&
      req.pattern !== 'role-differentiated'
    ) {
      return `enableVerifierGate only applies to blackboard-family patterns (got '${req.pattern}')`;
    }
    req.enableVerifierGate = obj.enableVerifierGate;
  }

  if (obj.enableAuditorGate !== undefined) {
    if (typeof obj.enableAuditorGate !== 'boolean') {
      return 'enableAuditorGate must be boolean';
    }
    if (
      obj.enableAuditorGate === true &&
      req.pattern !== 'blackboard' &&
      req.pattern !== 'orchestrator-worker' &&
      req.pattern !== 'role-differentiated'
    ) {
      return `enableAuditorGate only applies to blackboard-family patterns (got '${req.pattern}')`;
    }
    req.enableAuditorGate = obj.enableAuditorGate;
  }

  if (obj.auditEveryNCommits !== undefined) {
    if (
      typeof obj.auditEveryNCommits !== 'number' ||
      !Number.isInteger(obj.auditEveryNCommits) ||
      obj.auditEveryNCommits < 1 ||
      obj.auditEveryNCommits > 100
    ) {
      return 'auditEveryNCommits must be an integer between 1 and 100';
    }
    req.auditEveryNCommits = obj.auditEveryNCommits;
  }

  // Per-gate model pins (2026-04-24). Generic validation: non-empty
  // string; opencode authoritative on whether the model ID resolves.
  const pinFields: Array<keyof Pick<
    SwarmRunRequest,
    'criticModel' | 'verifierModel' | 'auditorModel'
  >> = ['criticModel', 'verifierModel', 'auditorModel'];
  for (const field of pinFields) {
    const val = (obj as Record<string, unknown>)[field];
    if (val === undefined) continue;
    if (typeof val !== 'string' || !val.trim()) {
      return `${field}, when provided, must be a non-empty model-ID string`;
    }
    req[field] = val.trim();
  }

  if (obj.workspaceDevUrl !== undefined) {
    if (typeof obj.workspaceDevUrl !== 'string' || !obj.workspaceDevUrl.trim()) {
      return 'workspaceDevUrl must be a non-empty string';
    }
    try {
      // eslint-disable-next-line no-new -- validation only
      new URL(obj.workspaceDevUrl);
    } catch {
      return 'workspaceDevUrl must be a valid URL (e.g. http://localhost:3000)';
    }
    req.workspaceDevUrl = obj.workspaceDevUrl;
  }

  // enableVerifierGate + workspaceDevUrl must come as a pair — the
  // verifier needs a target URL to navigate. Silent-ignoring a truthy
  // flag without a URL would mislead; better to reject up front.
  if (req.enableVerifierGate === true && !req.workspaceDevUrl) {
    return 'enableVerifierGate=true requires workspaceDevUrl (the target app URL to verify against)';
  }

  return req;
}
