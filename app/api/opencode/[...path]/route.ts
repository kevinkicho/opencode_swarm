import type { NextRequest } from 'next/server';
import { opencodeFetch } from '@/lib/opencode/client';
import {
  deriveRunRowCached,
  findRunBySession,
  getRun,
} from '@/lib/server/swarm-registry';

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
interface GateBlock {
  swarmRunID: string;
  costTotal: number;
  costCap: number;
}

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
      { error: 'opencode unreachable', target, message: (err as Error).message },
      { status: 502 }
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RES_HEADERS.has(key.toLowerCase())) outHeaders.set(key, value);
  });

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
