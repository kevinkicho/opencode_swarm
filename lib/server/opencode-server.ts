// Server-side opencode HTTP helpers.
//
// These mirror the `createSessionBrowser` / `postSessionMessageBrowser` pair in
// `lib/opencode/live.ts`, but call opencode directly from Node via
// `opencodeFetch` instead of going through the `/api/opencode` proxy. Route
// handlers that orchestrate multiple opencode calls (e.g. the swarm-run
// endpoint) use these so they can (a) reuse the same Basic-auth resolution
// everywhere and (b) avoid a self-request round-trip back into the proxy.
//
// Do NOT import this module from a Client Component — it reads server-only
// env vars indirectly (via `opencodeFetch`).
//
// Wire shapes intentionally match the browser helpers line-for-line so the
// swarm-run route can be migrated to pattern='blackboard' / 'map-reduce' by
// fanning out calls here without touching the browser's expectation of what
// an opencode session looks like.

import { opencodeFetch } from '../opencode/client';
import type { OpencodeSession } from '../opencode/client';

// Create a session scoped to `directory`. Opencode's POST /session accepts
// an optional { title } body; omitting it lets opencode mint a placeholder
// title that we'll overwrite once the first model turn produces a better one.
export async function createSessionServer(
  directory: string,
  title?: string
): Promise<OpencodeSession> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(`/session?${qs}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session create -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return (await res.json()) as OpencodeSession;
}

// Fire-and-forget prompt submission. Uses /prompt_async so the route handler
// can return immediately — SSE surfaces the resulting parts via the run's
// multiplexed events stream.
//
// `agent` is the opencode agent-config name (e.g. "build", "plan"). When set,
// opencode routes this prompt to that agent-config within the session. Omit
// to broadcast to the session's lead agent.
export async function postSessionMessageServer(
  sessionId: string,
  directory: string,
  text: string,
  opts: { agent?: string } = {}
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text }],
  };
  if (opts.agent) body.agent = opts.agent;
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/prompt_async?${qs}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode prompt -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
}
