// POST /api/swarm/run — creates one swarm run.
// GET  /api/swarm/run — lists every persisted run (newest-first) for the
//                       status-rail run picker.
//
// A run wraps N opencode sessions under one swarm coordinator. N=1 for
// pattern='none' (opencode native); N>=2 for multi-session presets like
// 'council' where each session is a parallel member of the same run.
// Patterns without coordinator code still reject at request time (501);
// see SWARM_PATTERNS.md §"Backend gap" for the roadmap.
//
// Lifecycle on success:
//   1. resolve effective teamSize (N) from pattern + request body
//   2. mint N opencode sessions in parallel (Promise.allSettled) — partial
//      success is accepted; zero survivors is a hard 502
//   3. if directive is set, post it to every survivor in parallel
//      (Promise.allSettled) — per-session failures log and continue
//   4. persist meta.json via registry.createRun() with every survivor's id
//   5. return { swarmRunID, sessionIDs, meta } to the browser
//
// Error shape matches the opencode proxy: { error, ...detail } with an
// HTTP status that reflects who failed (400 = client, 501 = unsupported,
// 502 = opencode, 500 = anything else).

import type { NextRequest } from 'next/server';

import { createSessionServer, postSessionMessageServer } from '@/lib/server/opencode-server';
import { createRun, deriveRunRowCached, getRun, listRuns } from '@/lib/server/swarm-registry';
import { runPlannerSweep } from '@/lib/server/blackboard/planner';
import { startAutoTicker } from '@/lib/server/blackboard/auto-ticker';
import { runCouncilRounds } from '@/lib/server/council';
import {
  buildScopedDirective,
  deriveSlices,
  detectScopeImbalance,
  runMapReduceSynthesis,
} from '@/lib/server/map-reduce';
import { runOrchestratorWorkerKickoff } from '@/lib/server/orchestrator-worker';
import { runRoleDifferentiatedKickoff } from '@/lib/server/role-differentiated';
import { runCriticLoopKickoff } from '@/lib/server/critic-loop';
import { runDebateJudgeKickoff } from '@/lib/server/debate-judge';
import { runDeliberateExecuteKickoff } from '@/lib/server/deliberate-execute';
import type {
  SwarmRunListRow,
  SwarmRunRequest,
  SwarmRunResponse,
} from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';
import { patternDefaults } from '@/lib/swarm-patterns';
import {
  collectOllamaModels,
  prewarmModels,
} from '@/lib/server/blackboard/model-prewarm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED_PATTERNS: ReadonlySet<SwarmPattern> = new Set([
  'none',
  'council',
  'blackboard',
  'map-reduce',
  'orchestrator-worker',
  'role-differentiated',
  'debate-judge',
  'critic-loop',
  'deliberate-execute',
]);

// Hard cap on multi-session fan-out. Picked to stay well inside opencode's
// parallel-prompt tolerance on the hosted Zen tier (probe margins, not a
// hard SDK limit). If a pattern legitimately needs more, raise this after
// measuring burst behavior — don't bypass it silently.
const TEAM_SIZE_MAX = 8;

// Pattern-specific defaults + floors. Encoded as a table so new patterns
// opt in by adding a row, not by branching the validator:
//   - `defaultSize`  is applied when the request omits teamSize
//   - `minSize` / `maxSize` clamp what the body is allowed to carry
// Patterns not in this table fall back to single-session (pattern='none'
// shape) so unsupported presets still get sensible defaults if they ever
// slip past SUPPORTED_PATTERNS.
const PATTERN_TEAM_SIZE: Record<
  SwarmPattern,
  { defaultSize: number; minSize: number; maxSize: number }
> = {
  none: { defaultSize: 1, minSize: 1, maxSize: 1 },
  council: { defaultSize: 3, minSize: 2, maxSize: TEAM_SIZE_MAX },
  blackboard: { defaultSize: 3, minSize: 2, maxSize: TEAM_SIZE_MAX },
  'map-reduce': { defaultSize: 3, minSize: 2, maxSize: TEAM_SIZE_MAX },
  // Orchestrator-worker: 1 orchestrator + at least 1 worker = minSize 2.
  // Default 4 = 1 orchestrator + 3 workers. Maxes match the other
  // multi-session patterns.
  'orchestrator-worker': {
    defaultSize: 4,
    minSize: 2,
    maxSize: TEAM_SIZE_MAX,
  },
  // Role-differentiated: N workers with pinned roles. Default 4 gives
  // the planner room to distribute todos across architect/impl/test/review
  // archetypes without overspending sessions on a 2-3 person shop.
  'role-differentiated': {
    defaultSize: 4,
    minSize: 2,
    maxSize: TEAM_SIZE_MAX,
  },
  // Debate+judge: 1 judge + at least 2 generators = minSize 3.
  // Default 4 = 1 judge + 3 generators (same shape as council but with
  // an automated decision surface instead of human reconcile).
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
  // Deliberate→Execute: council deliberation + blackboard execution in
  // sequence on the SAME session pool. N members all deliberate then all
  // execute. Default 3 mirrors council's default.
  'deliberate-execute': {
    defaultSize: 3,
    minSize: 2,
    maxSize: TEAM_SIZE_MAX,
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
    value === 'critic-loop' ||
    value === 'deliberate-execute'
  );
}

// Pulls a validated SwarmRunRequest out of the raw JSON body. Returns a
// string describing the first problem rather than throwing — the route
// translates that into a 400 with a human-readable detail.
function parseRequest(raw: unknown): SwarmRunRequest | string {
  if (!raw || typeof raw !== 'object') return 'body must be a JSON object';
  const obj = raw as Record<string, unknown>;

  if (!isSwarmPattern(obj.pattern)) return 'pattern must be one of: none, blackboard, map-reduce, council, orchestrator-worker, role-differentiated, debate-judge, critic-loop, deliberate-execute';

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
      req.pattern !== 'deliberate-execute' &&
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
    // Length check happens after teamSize is resolved below — we push
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
    // coordinator's done-transition path. Silent-ignore for those would
    // mislead the user; reject at the API instead.
    if (
      obj.enableCriticGate === true &&
      req.pattern !== 'blackboard' &&
      req.pattern !== 'orchestrator-worker' &&
      req.pattern !== 'role-differentiated' &&
      req.pattern !== 'deliberate-execute'
    ) {
      return `enableCriticGate only applies to blackboard-family patterns (got '${req.pattern}')`;
    }
    req.enableCriticGate = obj.enableCriticGate;
  }

  if (obj.enableVerifierGate !== undefined) {
    if (typeof obj.enableVerifierGate !== 'boolean') {
      return 'enableVerifierGate must be boolean';
    }
    // Same pattern constraint as the critic gate.
    if (
      obj.enableVerifierGate === true &&
      req.pattern !== 'blackboard' &&
      req.pattern !== 'orchestrator-worker' &&
      req.pattern !== 'role-differentiated' &&
      req.pattern !== 'deliberate-execute'
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
      req.pattern !== 'role-differentiated' &&
      req.pattern !== 'deliberate-execute'
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

// Continuation inheritance: when req.continuationOf is set, look up the
// prior run and fill in fields the new run should inherit (workspace,
// source). Also returns the ambition-ratchet tier to start at — the new
// run's first planner sweep picks up where the prior run left off, so a
// pattern switch mid-project doesn't reset ambition to tier 1.
//
// Rejections return a 400-ready error string. Success mutates `req` in
// place (fills workspace + source when they were blank) and returns the
// starting tier (≥ 1).
async function resolveContinuation(
  req: SwarmRunRequest,
): Promise<number | string> {
  if (!req.continuationOf) return 1;
  const prior = await getRun(req.continuationOf);
  if (!prior) {
    return `continuationOf: run '${req.continuationOf}' not found`;
  }
  if (!req.workspace) {
    req.workspace = prior.workspace;
  } else if (req.workspace !== prior.workspace) {
    return `continuationOf: workspace '${req.workspace}' does not match prior run's workspace '${prior.workspace}' — refusing silent fork`;
  }
  if (!req.source && prior.source) {
    req.source = prior.source;
  }
  // Tier clamp: prior.currentTier may have been set by a future
  // version with a different max. Clamp into [1, MAX_TIER_FLOOR=5]
  // here rather than letting a bogus value propagate into the planner
  // prompt. If the prior run exhausted tier 5 (tierExhausted), the new
  // run resumes at tier 5 — the planner will decide if there's still
  // tier-5 work to do.
  const priorTier = prior.currentTier ?? 1;
  return Math.max(1, Math.min(5, priorTier));
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = parseRequest(body);
  if (typeof parsed === 'string') {
    return Response.json({ error: parsed }, { status: 400 });
  }

  if (!SUPPORTED_PATTERNS.has(parsed.pattern)) {
    return Response.json(
      {
        error: `pattern '${parsed.pattern}' is not implemented yet`,
        hint: 'pattern="none", "council", and "blackboard" ship today — see SWARM_PATTERNS.md',
      },
      { status: 501 }
    );
  }

  // Resolve continuationOf inheritance before any session spawn so a
  // missing prior run fails fast without burning opencode resources.
  const continuation = await resolveContinuation(parsed);
  if (typeof continuation === 'string') {
    return Response.json({ error: continuation }, { status: 400 });
  }
  const startTier = continuation;

  // Resolve effective teamSize. The body is authoritative when present (it
  // was range-validated in parseRequest); otherwise fall back to the
  // pattern's default. The resolved value is what drives how many sessions
  // we spawn — meta.teamSize isn't persisted separately because
  // meta.sessionIDs.length carries the truth.
  const teamSize = parsed.teamSize ?? PATTERN_TEAM_SIZE[parsed.pattern].defaultSize;

  // Post-resolve length check for teamModels — teamSize defaults are
  // pattern-specific, so the validator couldn't enforce length until
  // now. Empty-or-unset means "no pinning"; a mismatched non-empty
  // array is a caller bug.
  if (parsed.teamModels && parsed.teamModels.length !== teamSize) {
    return Response.json(
      {
        error: `teamModels length ${parsed.teamModels.length} does not match resolved teamSize ${teamSize} for pattern '${parsed.pattern}'`,
      },
      { status: 400 },
    );
  }

  // Apply per-pattern model defaults (2026-04-24). For each field the
  // caller didn't supply, consult the pattern's default. User overrides
  // always win — this only plugs gaps. See lib/swarm-patterns.ts for
  // the mapping table and rationale.
  const defaults = patternDefaults[parsed.pattern];
  if (defaults.teamModels && !parsed.teamModels) {
    parsed.teamModels = defaults.teamModels(teamSize);
  }
  if (defaults.criticModel && !parsed.criticModel) {
    parsed.criticModel = defaults.criticModel;
  }
  if (defaults.verifierModel && !parsed.verifierModel) {
    parsed.verifierModel = defaults.verifierModel;
  }
  if (defaults.auditorModel && !parsed.auditorModel) {
    parsed.auditorModel = defaults.auditorModel;
  }
  if (defaults.teamRoles && !parsed.teamRoles && parsed.pattern === 'role-differentiated') {
    // Cycle or truncate to teamSize so the roles array lines up with
    // the session count (role-differentiated.ts validates this pairing).
    const roles: string[] = [];
    for (let i = 0; i < teamSize; i += 1) {
      roles.push(defaults.teamRoles[i % defaults.teamRoles.length]);
    }
    parsed.teamRoles = roles;
  }

  const seedTitle = parsed.title ?? parsed.directive?.split('\n', 1)[0]?.trim();

  // Step 0 (2026-04-24): pre-warm every ollama model this run will use.
  // Cloud-hosted ollama models can take 60 s+ for first-token on a cold
  // endpoint; opencode's /prompt client times out before that lands,
  // which hung every nemotron-pinned session in the previous multi-
  // pattern test. Firing a trivial /api/generate per unique model
  // collapses follow-up latency to ~1 s. Runs in parallel with session
  // creation so we don't pay for warmup time serially. See
  // lib/server/blackboard/model-prewarm.ts.
  //
  // Fire-and-forget from the HTTP response's POV (we don't block the
  // response on it), but we DO await the warmPromise before posting
  // directive/intro prompts below so nemotron is ready when we need it.
  const warmPromise = prewarmModels(collectOllamaModels(parsed));

  // Step 1: mint N opencode sessions in parallel. Promise.allSettled rather
  // than Promise.all so a partial failure (e.g. 2 of 3 spawn, one hits a
  // transient opencode hiccup) still produces a viable run with the
  // survivors. Zero survivors is a hard 502 — no amount of retry in the
  // browser will recover a run that spawned no sessions.
  //
  // For N>1 we append a member suffix to the title so sessions show up
  // distinctly in opencode's own UI. Single-session runs keep the title
  // unchanged so 'none' output doesn't visually drift.
  const titleFor = (idx: number): string | undefined => {
    if (!seedTitle) return undefined;
    return teamSize > 1 ? `${seedTitle} #${idx + 1}` : seedTitle;
  };

  const spawnResults = await Promise.allSettled(
    Array.from({ length: teamSize }, (_, idx) =>
      createSessionServer(parsed.workspace, titleFor(idx))
    )
  );

  const sessions = spawnResults
    .map((r, idx) => ({ result: r, idx }))
    .filter(({ result }) => result.status === 'fulfilled')
    .map(({ result, idx }) => ({
      id: (result as PromiseFulfilledResult<Awaited<ReturnType<typeof createSessionServer>>>).value.id,
      idx,
    }));

  const spawnFailures = spawnResults
    .map((r, idx) => ({ result: r, idx }))
    .filter(({ result }) => result.status === 'rejected');

  for (const { result, idx } of spawnFailures) {
    console.warn(
      `[swarm/run] session ${idx + 1}/${teamSize} spawn failed:`,
      (result as PromiseRejectedResult).reason instanceof Error
        ? ((result as PromiseRejectedResult).reason as Error).message
        : String((result as PromiseRejectedResult).reason)
    );
  }

  if (sessions.length === 0) {
    return Response.json(
      {
        error: 'opencode session create failed',
        message: `0 of ${teamSize} sessions spawned — opencode may be offline`,
        attempts: teamSize,
      },
      { status: 502 }
    );
  }

  // Wait for the pre-warm to settle before any prompt dispatch. By now
  // session creation (~1-2 s) has run in parallel with warmup, so the
  // remaining wait is usually seconds. On the first cold run for a
  // nemotron-heavy pattern, this can be up to 60 s — still faster than
  // a hung session that never responds.
  await warmPromise.catch((err) => {
    console.warn(
      '[swarm/run] model pre-warm threw (continuing without warm):',
      err instanceof Error ? err.message : String(err),
    );
  });

  // Step 2: post the directive to every surviving session in parallel.
  // Per-session failures log and continue — the session exists, the
  // composer can re-fire the prompt, and one slow member shouldn't stall
  // the fast ones. opencode's /prompt_async returns before the model turn
  // completes, so the await here is just the HTTP ack, not the reply.
  //
  // Shape varies by pattern:
  //   - blackboard  → skip this broadcast entirely. The directive is the
  //                   planner sweep's input, not a worker prompt. Workers
  //                   stay idle until the coordinator assigns them a todo.
  //   - map-reduce  → each session gets the base directive plus its own
  //                   scope annotation ("your slice: src/api/"). Slices are
  //                   auto-derived from the workspace's top-level dirs.
  //   - others      → every session gets the same uniform directive.
  // Skip patterns that post their own pattern-specific intros:
  //   - blackboard:           no directive post; planner sweep seeds work
  //   - orchestrator-worker:  orchestrator intro to session 0, workers quiet
  //   - role-differentiated:  role intros to each session, planner on arch
  //   - debate-judge:         generators + judge get different intros
  //   - critic-loop:          worker + critic get different intros
  //   - deliberate-execute:   starts like council, directive to all — DOES
  //                           go through this branch
  const patternsWithCustomIntro: ReadonlySet<SwarmPattern> = new Set([
    'blackboard',
    'orchestrator-worker',
    'role-differentiated',
    'debate-judge',
    'critic-loop',
  ]);
  if (
    !patternsWithCustomIntro.has(parsed.pattern) &&
    parsed.directive &&
    parsed.directive.trim()
  ) {
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
        })
      )
    );
    postResults.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.warn(
          `[swarm/run] directive post failed for session ${sessions[i].id}:`,
          r.reason instanceof Error ? r.reason.message : String(r.reason)
        );
      }
    });
  }

  // Step 2.5 (opt-in): spawn a dedicated critic session for the anti-
  // busywork gate. Lives outside the worker pool — NOT in sessionIDs —
  // so the coordinator doesn't tick it. If the spawn fails we swallow
  // the error and continue without a gate rather than fail the whole
  // run; the behavior degrades to "same as if the flag was off," which
  // is a safer failure mode than blocking run creation on an opt-in
  // feature. See lib/server/blackboard/critic.ts for the review path.
  let criticSessionID: string | undefined;
  if (parsed.enableCriticGate) {
    try {
      const critic = await createSessionServer(
        parsed.workspace,
        seedTitle ? `${seedTitle} · critic` : undefined,
      );
      criticSessionID = critic.id;
    } catch (err) {
      console.warn(
        '[swarm/run] critic session spawn failed — run continues without critic gate:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 2.6 (opt-in): same treatment for the verifier session (Playwright
  // grounding). Spawned only when enableVerifierGate is true AND the
  // user supplied workspaceDevUrl (validator already enforced this
  // pairing). See lib/server/blackboard/verifier.ts for the review path.
  let verifierSessionID: string | undefined;
  if (parsed.enableVerifierGate && parsed.workspaceDevUrl) {
    try {
      const verifier = await createSessionServer(
        parsed.workspace,
        seedTitle ? `${seedTitle} · verifier` : undefined,
      );
      verifierSessionID = verifier.id;
    } catch (err) {
      console.warn(
        '[swarm/run] verifier session spawn failed — run continues without verifier gate:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 2.7 (opt-in): auditor session for Stage 2 declared-roles
  // contract gate. Same fail-open spawn semantics as critic/verifier.
  // Auditor session is invoked every auditEveryNCommits commits + on
  // tier escalation + at run-end to verdict pending criteria — see
  // lib/server/blackboard/auditor.ts + the cadence logic in
  // lib/server/blackboard/auto-ticker.ts.
  let auditorSessionID: string | undefined;
  if (parsed.enableAuditorGate) {
    try {
      const auditor = await createSessionServer(
        parsed.workspace,
        seedTitle ? `${seedTitle} · auditor` : undefined,
      );
      auditorSessionID = auditor.id;
    } catch (err) {
      console.warn(
        '[swarm/run] auditor session spawn failed — run continues without auditor gate:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 3: persist meta.json with every survivor. If this fails we've
  // already created opencode sessions — accept the orphans rather than
  // introduce rollback. The user can see them in opencode's own UI; our
  // own ledger just won't know about them. Acceptable for a single-user
  // prototype.
  const sessionIDs = sessions.map((s) => s.id);

  // Survivor remap: teamModels[i] is index-aligned to the original
  // spawn slot i, but partial spawn failures mean sessions[] may have
  // fewer entries than the original array. Reindex to the surviving
  // slots so meta.teamModels[j] corresponds to meta.sessionIDs[j]. If
  // every session survived, `sessions[j].idx === j` and this is a
  // no-op copy.
  const teamModelsSurvivors = parsed.teamModels
    ? sessions.map((s) => parsed.teamModels![s.idx])
    : undefined;

  let meta;
  try {
    meta = await createRun(parsed, sessionIDs, {
      criticSessionID,
      verifierSessionID,
      auditorSessionID,
      startTier,
      teamModels: teamModelsSurvivors,
    });
  } catch (err) {
    return Response.json(
      {
        error: 'swarm-run registry write failed',
        message: (err as Error).message,
        orphanSessionIDs: sessionIDs,
      },
      { status: 500 }
    );
  }

  // Step 4 (blackboard only): kick off the initial planner sweep, then
  // start the auto-ticker once items land on the board. Both run in the
  // background — the HTTP response is allowed to return before the sweep
  // completes (90s upper bound) so the browser isn't stuck waiting.
  //
  // Ordering matters: we start the ticker *after* the sweep produces
  // items. Starting it before would have it tick repeatedly on an empty
  // board, and since auto-ticker auto-stops after 60s of idle, a slow
  // sweep (up to 90s) could strand the ticker right when todos finally
  // land. Starting post-sweep sidesteps the race.
  //
  // Sweep failure (zero todos / timeout / opencode error) logs and exits
  // without starting the ticker. Callers can retry via
  // POST /api/swarm/run/:id/board/sweep { "overwrite": true }.
  if (parsed.pattern === 'blackboard') {
    const runID = meta.swarmRunID;
    runPlannerSweep(runID)
      .then((result) => {
        if (result.items.length === 0) {
          console.warn(
            `[swarm/run] blackboard sweep for ${runID} produced 0 todos — auto-ticker not started`,
          );
          return;
        }
        console.log(
          `[swarm/run] blackboard sweep for ${runID} produced ${result.items.length} todos — starting auto-ticker`,
        );
        const periodicSweepMs =
          parsed.persistentSweepMinutes && parsed.persistentSweepMinutes > 0
            ? Math.round(parsed.persistentSweepMinutes * 60_000)
            : 0;
        startAutoTicker(runID, { periodicSweepMs });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[swarm/run] blackboard sweep for ${runID} failed:`,
          message,
        );
      });
  }

  // Step 5 (map-reduce only): kick off the synthesis orchestrator. Waits for
  // every map session to idle, then posts a synthesis prompt to
  // sessionIDs[0] with each sibling's final draft embedded. Runs fully in
  // the background — the HTTP response returns before any member has even
  // started working, let alone finished. Failures log and exit quietly; the
  // per-member drafts still sit in their session transcripts so the human
  // can reconcile manually even if synthesis never lands.
  if (parsed.pattern === 'map-reduce') {
    const runID = meta.swarmRunID;
    runMapReduceSynthesis(runID).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[swarm/run] map-reduce synthesis for ${runID} failed:`, message);
    });
  }

  // Step 6 (council only): kick off auto-rounds. Waits for every session to
  // idle at the end of Round 1, harvests each member's latest draft, fans
  // out a Round-2 prompt with peer drafts embedded. Repeats for up to
  // DEFAULT_MAX_ROUNDS total rounds. Runs fully in the background — the
  // ReconcileStrip manual "↻ round 2" button still works and can fire
  // additional rounds on top if a human wants more deliberation than the
  // auto-cadence provides.
  if (parsed.pattern === 'council') {
    const runID = meta.swarmRunID;
    runCouncilRounds(runID).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[swarm/run] council auto-rounds for ${runID} failed:`, message);
    });
  }

  // Step 7 (orchestrator-worker only): post the orchestrator intro to
  // session 0 with agent='orchestrator', fire the initial planner
  // sweep against that same session, then start the auto-ticker with
  // the orchestrator excluded from worker dispatch. Runs fully in the
  // background — the HTTP response returns before the orchestrator has
  // even started thinking. Failures log and exit; the sessions exist
  // and the human can manually kick things off from the composer.
  if (parsed.pattern === 'orchestrator-worker') {
    const runID = meta.swarmRunID;
    runOrchestratorWorkerKickoff(runID, {
      persistentSweepMinutes: parsed.persistentSweepMinutes,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[swarm/run] orchestrator-worker kickoff for ${runID} failed:`,
        message,
      );
    });
  }

  // Step 8 (role-differentiated only): post role-framed intros to workers,
  // fire planner sweep on session 0 (the architect), start auto-ticker
  // for standard board-claim dispatch. All sessions are workers from the
  // coordinator's POV — roles shape what they self-select, not routing.
  if (parsed.pattern === 'role-differentiated') {
    const runID = meta.swarmRunID;
    runRoleDifferentiatedKickoff(runID, {
      persistentSweepMinutes: parsed.persistentSweepMinutes,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[swarm/run] role-differentiated kickoff for ${runID} failed:`,
        message,
      );
    });
  }

  // Step 9 (critic-loop only): prime the critic with its contract, kick
  // the worker into producing a draft, loop review-revise until the
  // critic approves or the max-iterations cap fires.
  if (parsed.pattern === 'critic-loop') {
    const runID = meta.swarmRunID;
    runCriticLoopKickoff(runID, {
      maxIterations: parsed.criticMaxIterations,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[swarm/run] critic-loop kickoff for ${runID} failed:`,
        message,
      );
    });
  }

  // Step 10 (debate-judge only): prime judge + generators, run up to
  // debateMaxRounds rounds of generators-propose / judge-evaluate,
  // terminating on WINNER / MERGE verdict or round cap.
  if (parsed.pattern === 'debate-judge') {
    const runID = meta.swarmRunID;
    runDebateJudgeKickoff(runID, {
      maxRounds: parsed.debateMaxRounds,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[swarm/run] debate-judge kickoff for ${runID} failed:`,
        message,
      );
    });
  }

  // Step 11 (deliberate-execute only): compositional pattern. Runs
  // council-style deliberation rounds, synthesizes the converged drafts
  // into concrete todos, then kicks into blackboard-style execution on
  // the same session pool.
  if (parsed.pattern === 'deliberate-execute') {
    const runID = meta.swarmRunID;
    runDeliberateExecuteKickoff(runID, {
      persistentSweepMinutes: parsed.persistentSweepMinutes,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[swarm/run] deliberate-execute kickoff for ${runID} failed:`,
        message,
      );
    });
  }

  const payload: SwarmRunResponse = {
    swarmRunID: meta.swarmRunID,
    sessionIDs: meta.sessionIDs,
    meta,
  };
  return Response.json(payload, { status: 201 });
}

// Run discovery. Wrapped in { runs } rather than returning a bare array so
// future fields (cursor, total, filters) can land without breaking clients.
// Each row carries a live-derived status — see deriveRunStatus() for how
// it's classified from the primary session's message tail.
//
// Fan-out strategy: every list request does one opencode /message fetch per
// run, in parallel. A 2s in-memory TTL cache (deriveRunRowCached) collapses
// the hot path when polls come in faster than the TTL; appendEvent purges
// the entry for the affected run so new activity always shows up on the
// next poll. See swarm-registry.ts "derived-row cache" block for details.
//
// No server-side filtering at v1. Sort order is inherited from listRuns()
// (newest-first by createdAt); status-based sorting lives client-side in
// the picker so the order follows live signals without a round-trip.
export async function GET(): Promise<Response> {
  try {
    const metas = await listRuns();
    const rows: SwarmRunListRow[] = await Promise.all(
      metas.map(async (meta) => {
        // deriveRunRow is itself non-throwing — it collapses probe
        // failures to `unknown` + zero metrics — so this Promise.all never
        // rejects for per-row reasons. A rejection here would be an
        // unexpected crash path (e.g. OOM) and is fine to surface as a 500.
        const { status, lastActivityTs, costTotal, tokensTotal } =
          await deriveRunRowCached(meta);
        return { meta, status, lastActivityTs, costTotal, tokensTotal };
      })
    );
    return Response.json({ runs: rows });
  } catch (err) {
    return Response.json(
      { error: 'run list failed', message: (err as Error).message },
      { status: 500 }
    );
  }
}
