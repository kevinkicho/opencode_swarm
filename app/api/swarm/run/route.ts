// POST /api/swarm/run — creates one swarm run.
// GET  /api/swarm/run — lists every persisted run (newest-first) for the
//                       status-rail run picker.
//
// A run wraps N opencode sessions under one swarm coordinator. N=1 for
// pattern='none' (opencode native); N>=2 for multi-session presets like
// 'council' where each session is a parallel member of the same run.
// Patterns without coordinator code still reject at request time (501);
//
// Lifecycle on success:
//   1. parseRequest (lib/server/run/validate.ts) — pull a typed
//      SwarmRunRequest out of the JSON body
//   2. resolveContinuation (lib/server/run/continuation.ts) — fill in
//      workspace/source from a prior run when continuationOf is set
//   3. resolve effective teamSize (N) from pattern + request body
//   4. mint N opencode sessions in parallel (Promise.allSettled) — partial
//      success is accepted; zero survivors is a hard 502
//   5. if directive is set, post it to every survivor in parallel
//      (Promise.allSettled) — per-session failures log and continue
//   6. spawn opt-in critic / verifier / auditor sessions (best-effort;
//      failures surface in `gateFailures` on the 201)
//   7. persist meta.json via registry.createRun() with every survivor's id
//   8. invoke the per-pattern kickoff via the dispatcher table
//      (lib/server/run/kickoff/dispatcher.ts) — sync-throw-guarded so a
//      kickoff that rejects in the first 150ms returns 5xx instead of 201
//   9. return { swarmRunID, sessionIDs, meta, gateFailures? } to the browser
//
// continuation resolver, and per-pattern kickoff dispatch all moved to
// lib/server/run/. The route file is now the orchestration shell that
// wires those modules together.
//
// Error shape matches the opencode proxy: { error, ...detail } with an
// HTTP status that reflects who failed (400 = client, 501 = unsupported,
// 502 = opencode, 500 = anything else).

import type { NextRequest } from 'next/server';

import { createSessionServer } from '@/lib/server/opencode-server';
import { createRun, deriveRunRowCached, listRuns } from '@/lib/server/swarm-registry';
import { listBoardItems } from '@/lib/server/blackboard/store';
import { detectStuckDeliberation } from '@/lib/server/stuck-detector';
import {
  attachLateFailureLog,
  raceKickoffSync,
} from '@/lib/server/run/kickoff-guard';
import { parseRequest, PATTERN_TEAM_SIZE, SUPPORTED_PATTERNS } from '@/lib/server/run/validate';
import { resolveContinuation } from '@/lib/server/run/continuation';
import { invokeKickoff } from '@/lib/server/run/kickoff/dispatcher';
import { dispatchInitialDirective } from '@/lib/server/run/dispatch-intro';
import { spawnGateSessions } from '@/lib/server/run/spawn-gates';
import type {
  SwarmRunListRow,
  SwarmRunResponse,
} from '@/lib/swarm-run-types';
import { patternDefaults, teamSizeWarningMessage } from '@/lib/swarm-patterns';
import {
  collectOllamaModels,
  prewarmModels,
} from '@/lib/server/blackboard/model-prewarm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
 hint: 'pattern="none", "council", and "blackboard" ship today — see ',
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

  // Per-pattern empirical sanity warning (#101). teamSize > recommendedMax
  // is allowed (route still accepts up to TEAM_SIZE_MAX), but we surface a
  // dev-log line so the operator knows the run is in territory the
  // 2026-04-26 stress test caught failure modes in.
  const sanityWarn = teamSizeWarningMessage(parsed.pattern, teamSize);
  if (sanityWarn) console.warn(sanityWarn);

  // Post-resolve length check for teamModels — teamSize defaults are
  // pattern-specific, so the validator couldn't enforce length until now.
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
  if (defaults.synthesisModel && !parsed.synthesisModel) {
    parsed.synthesisModel = defaults.synthesisModel;
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
  // enableAuditorGate default. Caller-undefined → take the pattern's
  // default; explicit boolean from caller always wins (validator above
  // already coerced it onto parsed). Spawning the auditor seat is the
  // route's responsibility once parsed.enableAuditorGate is true.
  if (
    defaults.enableAuditorGate !== undefined &&
    parsed.enableAuditorGate === undefined
  ) {
    parsed.enableAuditorGate = defaults.enableAuditorGate;
  }

  const seedTitle = parsed.title ?? parsed.directive?.split('\n', 1)[0]?.trim();

  // Step 0 (2026-04-24): pre-warm every ollama model this run will use.
  // Cloud-hosted ollama models can take 60 s+ for first-token on a cold
  // endpoint; opencode's /prompt client times out before that lands.
  // Firing a trivial /api/generate per unique model collapses follow-up
  // latency to ~1 s. Runs in parallel with session creation.
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
        detail: `0 of ${teamSize} sessions spawned — opencode may be offline`,
        attempts: teamSize,
      },
      { status: 502 }
    );
  }

  // Wait for the pre-warm to settle before any prompt dispatch. By now
  // session creation (~1-2 s) has run in parallel with warmup, so the
  // remaining wait is usually seconds.
  await warmPromise.catch((err) => {
    console.warn(
      '[swarm/run] model pre-warm threw (continuing without warm):',
      err instanceof Error ? err.message : String(err),
    );
  });

  // Step 2: post the initial directive (skipped for patterns with custom
  // intros). See lib/server/run/dispatch-intro.ts.
  await dispatchInitialDirective(parsed, sessions);

  // Step 2.5–2.7: spawn opt-in critic / verifier / auditor sessions
  // (best-effort; failures surface in `gateFailures` on the 201).
  // See lib/server/run/spawn-gates.ts.
  const {
    criticSessionID,
    verifierSessionID,
    auditorSessionID,
    failures: gateFailures,
  } = await spawnGateSessions(parsed, seedTitle);

  // Step 3: persist meta.json with every survivor. If this fails we've
  // already created opencode sessions — accept the orphans rather than
  // introduce rollback. The user can see them in opencode's own UI; our
  // own ledger just won't know about them. Acceptable for a single-user
  // prototype.
  const sessionIDs = sessions.map((s) => s.id);

  // Survivor remap: teamModels[i] is index-aligned to the original
  // spawn slot i, but partial spawn failures mean sessions[] may have
  // fewer entries than the original array. Reindex to the surviving
  // slots so meta.teamModels[j] corresponds to meta.sessionIDs[j].
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
        detail: (err as Error).message,
        orphanSessionIDs: sessionIDs,
      },
      { status: 500 }
    );
  }

  // Step 4: per-pattern kickoff via the dispatcher table.
  //
  // guard. If the kickoff settles (rejects) within the 150ms window, the
  // route returns 5xx with `{ error: 'kickoff-failed', detail }` instead
  // of 201 with a phantom run. If it's still pending after the window,
  // the orchestrator owns its own outcome from there — we attach a tail
  // console.warn so late failures still leave a forensic trace.
  //
  // Pre-fix: every kickoff was inline `kickoff().catch((err) => warn(...))`,
  // returning 201 even when the orchestrator threw on its first await.
  // That created "alive zombie" runs (MAXTEAM-2026-04-26 incident class).
  const runID = meta.swarmRunID;
  const kickoff = invokeKickoff(parsed.pattern, runID, parsed);

  if (kickoff) {
    const sync = await raceKickoffSync(kickoff.promise);
    if (sync.kind === 'rejected') {
      console.warn(
        `[swarm/run] ${kickoff.label} kickoff for ${runID} rejected synchronously:`,
        sync.error.message,
      );
      return Response.json(
        {
          error: 'kickoff-failed',
          detail: sync.error.message,
          swarmRunID: runID,
          sessionIDs: meta.sessionIDs,
        },
        { status: 502 },
      );
    }
    if (sync.kind === 'pending') {
      attachLateFailureLog(kickoff.promise, kickoff.label, runID);
    }
  }

  const payload: SwarmRunResponse = {
    swarmRunID: meta.swarmRunID,
    sessionIDs: meta.sessionIDs,
    meta,
    ...(Object.keys(gateFailures).length > 0 ? { gateFailures } : {}),
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
// next poll.
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
        // #104 — stuck-deliberation flag. listBoardItems is local SQLite
        // (sub-ms per call) so adding it to every list row is cheap;
        // detectStuckDeliberation is a pure helper.
        let stuck: { reason: string } | undefined;
        try {
          if (typeof meta.createdAt === 'number') {
            const boardItemCount = listBoardItems(meta.swarmRunID).length;
            const result = detectStuckDeliberation({
              tokensTotal,
              ageMs: Date.now() - meta.createdAt,
              boardItemCount,
            });
            if (result.stuck && result.reason) {
              stuck = { reason: result.reason };
            }
          }
        } catch {
          // Best-effort: stuck detection isn't load-bearing for the
          // list render; fall through without the flag if it threw.
        }
        const row: SwarmRunListRow = {
          meta,
          status,
          lastActivityTs,
          costTotal,
          tokensTotal,
        };
        if (stuck) row.stuck = stuck;
        return row;
      })
    );
    return Response.json({ runs: rows });
  } catch (err) {
    return Response.json(
      { error: 'run list failed', detail: (err as Error).message },
      { status: 500 }
    );
  }
}
