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
import type { OpencodeMessage } from '../opencode/types';

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

// Read session messages. The status deriver only needs the last assistant
// message to classify a run, but opencode's /message endpoint always returns
// the full history — there's no tail/limit param at this revision. At
// prototype scale each call is a few KB, acceptable for a 4s poll over a
// small ledger. If it starts to hurt, the fix is a server-side cache keyed
// by (sessionID, time.updated) — see GET /api/swarm/run for the plan.
export async function getSessionMessagesServer(
  sessionId: string,
  directory: string,
  signal?: AbortSignal
): Promise<OpencodeMessage[]> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/message?${qs}`,
    { signal }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session messages -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return (await res.json()) as OpencodeMessage[];
}

// Session-aggregate diff. Opencode returns one entry per changed file with a
// unified-diff string covering every patch that landed in the session. There
// is no per-turn granularity from this endpoint (?messageID= / ?hash= are
// ignored — probed 2026-04-20); the memory layer stores these at rollup time
// so shape='diffs' recall can return real hunks instead of just part metadata.
export async function getSessionDiffServer(
  sessionId: string,
  directory: string,
  signal?: AbortSignal
): Promise<Array<{ file: string; patch: string }>> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/diff?${qs}`,
    { signal }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session diff -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
  return (await res.json()) as Array<{ file: string; patch: string }>;
}

// Cancels any in-flight model turn for this session. Soft cancel — any tool
// call that already dispatched finishes, but no further reasoning or tool
// invocations fire. Mirrors `abortSessionBrowser` in lib/opencode/live.ts.
//
// Use this whenever a server-side orchestrator gives up on a session (timeout,
// error, etc.) — without an explicit abort the opencode session keeps
// streaming turns into the void, burning tokens on work that no longer has
// a consumer.
export async function abortSessionServer(
  sessionId: string,
  directory: string,
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await opencodeFetch(
    `/session/${encodeURIComponent(sessionId)}/abort?${qs}`,
    { method: 'POST' },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode abort -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
    );
  }
}

// Fire-and-forget prompt submission. Uses /prompt_async so the route handler
// can return immediately — SSE surfaces the resulting parts via the run's
// multiplexed events stream.
//
// `agent` is the opencode agent-config name (e.g. "build", "plan"). When set,
// opencode routes this prompt to that agent-config within the session. Omit
// to broadcast to the session's lead agent.
//
// `model` is a direct model ID (e.g. "opencode/claude-sonnet-4-6" or
// "ollama/glm-5.1:cloud"). When set AND agent is unset, opencode runs the
// turn against that model instead of the session's default. When BOTH are
// set, opencode's agent-config takes precedence — the named agent's
// configured model overrides the direct model hint. Used by the team-
// picker wiring to pin a session to a specific provider/model across its
// whole lifetime (the coordinator threads the same `model` through every
// worker dispatch for the session).
export async function postSessionMessageServer(
  sessionId: string,
  directory: string,
  text: string,
  opts: { agent?: string; model?: string } = {}
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text }],
  };
  if (opts.agent) body.agent = opts.agent;
  if (opts.model) {
    // Opencode's /prompt expects `model` as an object
    // `{ providerID, modelID }`, not a bare string. Parse the canonical
    // `<provider>/<model>` shape used throughout our catalog (e.g.
    // `ollama/glm-5.1:cloud`, `opencode-go/glm-5.1`). First `/` is the
    // provider-model separator; model ID can contain further slashes
    // (`:cloud` suffixes are safe — they're inside the modelID segment).
    const slash = opts.model.indexOf('/');
    if (slash > 0) {
      body.model = {
        providerID: opts.model.slice(0, slash),
        modelID: opts.model.slice(slash + 1),
      };
    } else {
      // No slash — fall back to opencode's default provider with the
      // raw string as modelID. Lets callers pass a bare opencode slug
      // like `glm-5.1` and have opencode resolve its default provider.
      body.model = { providerID: 'opencode', modelID: opts.model };
    }
  }
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
