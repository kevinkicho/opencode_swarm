import type { NextRequest } from 'next/server';
import { opencodeFetch } from '@/lib/opencode/client';

// Next.js 14 App Router catch-all route: /api/opencode/* is forwarded to the
// opencode instance. Auth is injected server-side by opencodeFetch — the browser
// never sees OPENCODE_BASIC_USER / OPENCODE_BASIC_PASS.
//
// SSE streams (e.g. /api/opencode/event) are supported: we pipe res.body through
// as a ReadableStream so the connection stays open.

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

async function proxy(
  req: NextRequest,
  { params }: { params: { path: string[] } }
): Promise<Response> {
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
