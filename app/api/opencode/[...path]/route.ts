import type { NextRequest } from 'next/server';
import { opencodeFetch } from '@/lib/opencode/client';
import {
  deriveRunRowCached,
  findRunBySession,
  getRun,
} from '@/lib/server/swarm-registry';
import type { CostCapGateBlock } from '@/lib/api-types';

// Next.js 14 App Router catch-all route: /api/opencode/* is forwarded to the
// opencode instance. Auth is injected server-side by opencodeFetch — the browser
// never sees OPENCODE_BASIC_USER / OPENCODE_BASIC_PASS.
//
// SSE streams (e.g. /api/opencode/event) are supported: we pipe res.body through
// as a ReadableStream so the connection stays open.
//
// This proxy is also where the swarm cost-cap gate sits (DESIGN.md §9). For
// POSTs to /session/{id}/prompt or /prompt_async we:
//   1. resolve the sessionID to its swarm run (if any)
//   2. compare the run's accumulated $ to bounds.costCap
//   3. return 402 before the prompt reaches opencode when over
//
// Direct `?session=` flows (sessions not in any swarm run) are ungated —
// they're opting out of swarm management by construction. Runs without a
// bounds.costCap are ungated for the same reason: no cap declared, no wall.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Hop-by-hop and request-specific headers we must not forward upstream.
const STRIP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'authorization',
  'cookie',
]);

// Proxy-level TTL cache for GET /session/{id}/message — opencode's
// /message endpoint serializes the full message graph for a session,
// which on long runs (17+ msgs × N parts each) regularly takes 10-15s
// per call. The browser fires these from multiple surfaces (live-runs
// hook + per-session inspector + SSE-driven refetch fallback) and
// each fires its own fetch through this proxy. Without dedupe, a
// 30s page-load fans out 5+ identical /message fetches, each blocking
// for 10-15s. A 3s TTL collapses rapid duplicates to one upstream
// hit while keeping the data fresh enough for the polling cadence
// (browsers poll at 3-4s intervals).
//
// Only caches GET responses with status 200; SSE streams (text/event-
// stream) are passed through untouched. Cache key includes the full
// path + query so different sessions don't collide.
//
// Profiled 2026-04-27: page hydrate fanned 51 fetches over 60s; the
// /message lane was the dominant pole (5 × 10-15s per session, 3
// sessions). Cache target hit rate ~50% (every other poll within 3s
// of a prior).
const MSG_CACHE_KEY = Symbol.for('opencode_swarm.proxyMsgCache.v1');
const MSG_CACHE_TTL_MS = 3000;
interface MsgCacheEntry {
  body: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}
function getMsgCache(): Map<string, MsgCacheEntry> {
  const g = globalThis as { [MSG_CACHE_KEY]?: Map<string, MsgCacheEntry> };
  const slot = g[MSG_CACHE_KEY];
  if (slot instanceof Map) return slot;
  const next = new Map<string, MsgCacheEntry>();
  g[MSG_CACHE_KEY] = next;
  return next;
}
// Trim cache periodically to keep size bounded — entries past TTL are
// useless and accumulating sessions over a long-running dev process
// would leak memory.
function pruneMsgCache(): void {
  const cache = getMsgCache();
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > MSG_CACHE_TTL_MS * 4) cache.delete(key);
  }
}

// Response headers we must not forward back to the browser.
const STRIP_RES_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
]);

// Return the sessionID for POSTs that should trip the cost-cap gate, or null
// for everything else. Matching the URL shape `/session/{id}/prompt[_async]`
// exactly keeps permission replies and other session-scoped endpoints
// ungated — those are control traffic, not spend.
function gatedSessionID(
  method: string,
  pathSegs: string[]
): string | null {
  if (method !== 'POST') return null;
  if (pathSegs.length !== 3) return null;
  if (pathSegs[0] !== 'session') return null;
  if (pathSegs[2] !== 'prompt' && pathSegs[2] !== 'prompt_async') return null;
  return pathSegs[1] ?? null;
}

// Result shape for the gate check. `null` means "let the prompt through";
// an object means "block with this 402 body".
//
type GateBlock = CostCapGateBlock;

// On probe failure (opencode unreachable, session vanished) we return null
// and let the prompt through — availability beats a false positive when the
// cost signal is missing. A rolling overspend is recoverable; a false block
// stops useful work.
async function checkCostCap(
  sessionID: string
): Promise<GateBlock | null> {
  const swarmRunID = await findRunBySession(sessionID);
  if (!swarmRunID) return null;
  const meta = await getRun(swarmRunID);
  const costCap = meta?.bounds?.costCap;
  if (!meta || typeof costCap !== 'number') return null;
  const row = await deriveRunRowCached(meta);
  if (row.costTotal < costCap) return null;
  return { swarmRunID, costTotal: row.costTotal, costCap };
}

async function proxy(
  req: NextRequest,
  { params }: { params: { path: string[] } }
): Promise<Response> {
  const gateSession = gatedSessionID(req.method, params.path);
  if (gateSession) {
    try {
      const block = await checkCostCap(gateSession);
      if (block) {
        return Response.json(
          {
            error: 'cost-cap exceeded',
            swarmRunID: block.swarmRunID,
            costTotal: block.costTotal,
            costCap: block.costCap,
            message:
              'swarm run hit its cost cap — raise the cap in the routing modal or start a new run',
          },
          { status: 402 }
        );
      }
    } catch (err) {
      // Gate probe threw (disk I/O, malformed meta). Log and let through —
      // same safety-vs-availability choice as the probe-unknown path above.
      console.warn(
        `[cost-cap gate] probe failed for session ${gateSession}: ${(err as Error).message}`
      );
    }
  }

  const target = `/${params.path.join('/')}${req.nextUrl.search}`;

  // Cache check: only GET /session/{id}/message — that's the slow lane
  // we're trying to dedupe. All other requests fall through to the
  // upstream untouched.
  const isMessageGet =
    req.method === 'GET' &&
    params.path.length === 3 &&
    params.path[0] === 'session' &&
    params.path[2] === 'message';
  if (isMessageGet) {
    pruneMsgCache();
    const cache = getMsgCache();
    const cached = cache.get(target);
    if (cached && Date.now() - cached.fetchedAt < MSG_CACHE_TTL_MS) {
      const headers = new Headers({ 'content-type': cached.contentType });
      headers.set('x-proxy-cache', 'hit');
      return new Response(cached.body, { status: 200, headers });
    }
  }

  const forwardHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQ_HEADERS.has(key.toLowerCase())) forwardHeaders.set(key, value);
  });

  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await opencodeFetch(target, init);
  } catch (err) {
    return Response.json(
      { error: 'opencode unreachable', target, detail: (err as Error).message },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RES_HEADERS.has(key.toLowerCase())) outHeaders.set(key, value);
  });

  // Cache write: only on a successful GET /message. Buffer the body
  // (small, 10-200KB typical) and store. Subsequent reads within TTL
  // serve from cache. Streaming responses (SSE on /event) skip this
  // path because isMessageGet only matches /session/X/message.
  if (isMessageGet && upstream.status === 200) {
    try {
      const body = await upstream.arrayBuffer();
      const contentType = upstream.headers.get('content-type') ?? 'application/json';
      getMsgCache().set(target, { body, contentType, fetchedAt: Date.now() });
      outHeaders.set('x-proxy-cache', 'miss');
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    } catch {
      // Fall through to streaming pass-through if buffering fails.
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};
