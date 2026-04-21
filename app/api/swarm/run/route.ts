// POST /api/swarm/run — creates one swarm run.
// GET  /api/swarm/run — lists every persisted run (newest-first) for the
//                       status-rail run picker.
//
// At v1 a "run" wraps exactly one opencode session (pattern='none'). The
// surface is shaped for N sessions so the blackboard / map-reduce / council
// patterns can light up here without breaking the wire contract. Those
// patterns are rejected at request time (501) until their coordinator code
// lands — see SWARM_PATTERNS.md §"Backend gap" for the roadmap.
//
// Lifecycle on success:
//   1. mint opencode session via createSessionServer()
//   2. if directive is set, post it as the first message (fire-and-forget)
//   3. persist meta.json via registry.createRun()
//   4. return { swarmRunID, sessionIDs, meta } to the browser
//
// Error shape matches the opencode proxy: { error, ...detail } with an
// HTTP status that reflects who failed (400 = client, 501 = unsupported,
// 502 = opencode, 500 = anything else).

import type { NextRequest } from 'next/server';

import { createSessionServer, postSessionMessageServer } from '@/lib/server/opencode-server';
import { createRun, deriveRunStatus, listRuns } from '@/lib/server/swarm-registry';
import type {
  SwarmRunListRow,
  SwarmRunRequest,
  SwarmRunResponse,
} from '@/lib/swarm-run-types';
import type { SwarmPattern } from '@/lib/swarm-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SUPPORTED_PATTERNS: ReadonlySet<SwarmPattern> = new Set(['none']);

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
    if (typeof obj.teamSize !== 'number' || !Number.isFinite(obj.teamSize)) {
      return 'teamSize must be a finite number';
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
        hint: 'only pattern="none" ships at v1 — see SWARM_PATTERNS.md',
      },
      { status: 501 }
    );
  }

  // Step 1: mint the opencode session. Title seed falls back to the first
  // line of the directive so sessions that show up in opencode's session
  // list have a human-readable label before the first model turn completes.
  let session;
  try {
    const seedTitle = parsed.title ?? parsed.directive?.split('\n', 1)[0]?.trim();
    session = await createSessionServer(parsed.workspace, seedTitle);
  } catch (err) {
    return Response.json(
      { error: 'opencode session create failed', message: (err as Error).message },
      { status: 502 }
    );
  }

  // Step 2: fire the first prompt if a directive was supplied. We await the
  // POST so the browser sees a failure here as a 502, but opencode's
  // /prompt_async returns before the model turn completes — the SSE stream
  // is where progress actually shows up.
  if (parsed.directive && parsed.directive.trim()) {
    try {
      await postSessionMessageServer(session.id, parsed.workspace, parsed.directive);
    } catch (err) {
      // Don't abandon the run — the session exists, the meta write below
      // will still succeed, and the user can re-prompt from the composer.
      // Log and continue so the happy path isn't blocked by a transient
      // opencode hiccup on the initial prompt.
      console.warn('[swarm/run] initial directive post failed:', (err as Error).message);
    }
  }

  // Step 3: persist meta.json. If this fails we've already created an
  // opencode session — accept the orphan rather than introduce rollback.
  // The user can see the session in opencode's own UI; our own ledger just
  // won't know about it. Acceptable for v1 (see DESIGN.md §10).
  let meta;
  try {
    meta = await createRun(parsed, [session.id]);
  } catch (err) {
    return Response.json(
      {
        error: 'swarm-run registry write failed',
        message: (err as Error).message,
        orphanSessionID: session.id,
      },
      { status: 500 }
    );
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
// run, in parallel. At prototype scale (~10s of runs, 4s client poll) that
// lands around 10 req/s to opencode. When this starts to hurt, the fix is
// a process-memory cache: `Map<swarmRunID, { row, fetchedAt }>` with a
// ~2s TTL, invalidated when the multiplexer appends an event for that run.
// Not built yet — flag and move on.
//
// No server-side filtering at v1. Sort order is inherited from listRuns()
// (newest-first by createdAt); status-based sorting lives client-side in
// the picker so the order follows live signals without a round-trip.
export async function GET(): Promise<Response> {
  try {
    const metas = await listRuns();
    const rows: SwarmRunListRow[] = await Promise.all(
      metas.map(async (meta) => {
        // deriveRunStatus is itself non-throwing — it collapses probe
        // failures to `unknown` — so this Promise.all never rejects for
        // per-row reasons. A rejection here would be an unexpected crash
        // path (e.g. OOM) and is fine to surface as a 500.
        const { status, lastActivityTs } = await deriveRunStatus(meta);
        return { meta, status, lastActivityTs };
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
