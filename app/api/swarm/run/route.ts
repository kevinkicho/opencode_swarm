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
import { createRun, deriveRunRowCached, listRuns } from '@/lib/server/swarm-registry';
import { runPlannerSweep } from '@/lib/server/blackboard/planner';
import { startAutoTicker } from '@/lib/server/blackboard/auto-ticker';
import { runCouncilRounds } from '@/lib/server/council';
import {
  buildScopedDirective,
  deriveSlices,
  runMapReduceSynthesis,
} from '@/lib/server/map-reduce';
import type {
  SwarmRunListRow,
  SwarmRunRequest,
  SwarmRunResponse,
} from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED_PATTERNS: ReadonlySet<SwarmPattern> = new Set([
  'none',
  'council',
  'blackboard',
  'map-reduce',
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
};

function isSwarmPattern(value: unknown): value is SwarmPattern {
  return (
    value === 'none' ||
    value === 'blackboard' ||
    value === 'map-reduce' ||
    value === 'council'
  );
}

// Pulls a validated SwarmRunRequest out of the raw JSON body. Returns a
// string describing the first problem rather than throwing — the route
// translates that into a 400 with a human-readable detail.
function parseRequest(raw: unknown): SwarmRunRequest | string {
  if (!raw || typeof raw !== 'object') return 'body must be a JSON object';
  const obj = raw as Record<string, unknown>;

  if (!isSwarmPattern(obj.pattern)) return 'pattern must be one of: none, blackboard, map-reduce, council';
  if (typeof obj.workspace !== 'string' || !obj.workspace.trim()) {
    return 'workspace (absolute path) is required';
  }

  const req: SwarmRunRequest = {
    pattern: obj.pattern,
    workspace: obj.workspace,
  };

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
    const bounds: { costCap?: number; minutesCap?: number } = {};
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
    req.bounds = bounds;
  }

  return req;
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

  // Resolve effective teamSize. The body is authoritative when present (it
  // was range-validated in parseRequest); otherwise fall back to the
  // pattern's default. The resolved value is what drives how many sessions
  // we spawn — meta.teamSize isn't persisted separately because
  // meta.sessionIDs.length carries the truth.
  const teamSize = parsed.teamSize ?? PATTERN_TEAM_SIZE[parsed.pattern].defaultSize;
  const seedTitle = parsed.title ?? parsed.directive?.split('\n', 1)[0]?.trim();

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
  if (
    parsed.pattern !== 'blackboard' &&
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
    } else {
      directives = sessions.map(() => directive);
    }
    const postResults = await Promise.allSettled(
      sessions.map((s, i) =>
        postSessionMessageServer(s.id, parsed.workspace, directives[i])
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

  // Step 3: persist meta.json with every survivor. If this fails we've
  // already created opencode sessions — accept the orphans rather than
  // introduce rollback. The user can see them in opencode's own UI; our
  // own ledger just won't know about them. Acceptable for a single-user
  // prototype.
  const sessionIDs = sessions.map((s) => s.id);
  let meta;
  try {
    meta = await createRun(parsed, sessionIDs);
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
        startAutoTicker(runID);
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
