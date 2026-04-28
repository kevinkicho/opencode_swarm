'use client';

//
// Browser-side HTTP fetchers + query-key factories + the CostCapError
// class. Talks to our Next.js proxy at `/api/opencode/*` — the proxy
// injects Basic auth server-side, so no credentials ship here.
//
// Pre-split, these all lived inline at the top of lib/opencode/live.ts.
// Lifting them here lets the per-hook files import only the fetchers
// they need without dragging the whole hook layer into their compile
// graph.

import type {
  OpencodeBuiltinAgent,
  OpencodeCommand,
  OpencodeConfig,
  OpencodeMcpStatusMap,
  OpencodeMessage,
  OpencodePermissionReply,
  OpencodePermissionRequest,
  OpencodeProject,
  OpencodeSession,
  OpencodeTodo,
  OpencodeToolIds,
} from '../types';
import { OpencodeHttpError } from '../errors';

async function getJsonBrowser<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/opencode${path}`, { ...init, cache: 'no-store' });
  if (!res.ok) throw new OpencodeHttpError(path, res.status);
  const body = await res.json();
  if (body && typeof body === 'object' && !Array.isArray(body) && 'value' in body) {
    return (body as { value: T }).value;
  }
  return body as T;
}

export function getProjectsBrowser(init: RequestInit = {}): Promise<OpencodeProject[]> {
  return getJsonBrowser<OpencodeProject[]>('/project', init);
}

export function getSessionsByDirectoryBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeSession[]> {
  const qs = new URLSearchParams({ directory });
  return getJsonBrowser<OpencodeSession[]>(`/session?${qs.toString()}`, init);
}

export async function getAllSessionsBrowser(
  init: RequestInit = {}
): Promise<OpencodeSession[]> {
  // Probed 2026-04-21: bare GET /session only returns projectID="global"
  // sessions — project-scoped sessions (the ones opencode's CLI creates when
  // launched inside a registered worktree) are omitted. To get a complete
  // list we have to enumerate projects and fan out with ?directory=<worktree>.
  const [globals, projects] = await Promise.all([
    getJsonBrowser<OpencodeSession[]>('/session', init),
    getProjectsBrowser(init).catch(() => [] as OpencodeProject[]),
  ]);
  const scoped = await Promise.all(
    projects
      .filter((p) => p.id !== 'global' && p.worktree)
      .map((p) =>
        getSessionsByDirectoryBrowser(p.worktree, init).catch(
          () => [] as OpencodeSession[]
        )
      )
  );
  // Deliberately NOT sorted here: with many agents firing messages, sorting
  // by time.updated would make the picker reshuffle constantly. The consumer
  // applies an explicit sort (or leaves the natural merge order).
  const seen = new Set<string>();
  const unique: OpencodeSession[] = [];
  for (const s of [...globals, ...scoped.flat()]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    unique.push(s);
  }
  return unique;
}

export function getSessionMessagesBrowser(
  sessionId: string,
  init: RequestInit = {}
): Promise<OpencodeMessage[]> {
  return getJsonBrowser<OpencodeMessage[]>(
    `/session/${encodeURIComponent(sessionId)}/message`,
    init
  );
}

// Query-key factory for session messages. Centralized so both
// useLiveSession and useLiveSwarmRunMessages use the same key shape and
// TanStack Query's cache dedups across them — the primary session in a
// swarm run used to be fetched twice (once per hook) on every cold load.
export function sessionMessagesQueryKey(sessionId: string) {
  return ['session', sessionId, 'messages'] as const;
}

// Single-session lookup. Opencode exposes `/session/:id` returning the
// full OpencodeSession record (probed 2026-04-24 via direct curl: 6-45ms
// latency). Prefer this over getAllSessionsBrowser when you already know
// which session you want — saves a fan-out across every project in the
// hub.
export function getSessionBrowser(
  sessionId: string,
  directory?: string,
  init: RequestInit = {}
): Promise<OpencodeSession> {
  const qs = directory ? `?${new URLSearchParams({ directory }).toString()}` : '';
  return getJsonBrowser<OpencodeSession>(
    `/session/${encodeURIComponent(sessionId)}${qs}`,
    init
  );
}

// Per-session diff. Opencode returns one entry per file with the unified-diff
// text concatenating every change in the session. The `messageID` query param
// is documented but observed to no-op in practice (probed 2026-04-20) — turn
// scoping has to come from patch parts' file lists client-side.
export function getSessionDiffBrowser(
  sessionId: string,
  init: RequestInit = {}
): Promise<Array<{ file: string; patch: string }>> {
  return getJsonBrowser<Array<{ file: string; patch: string }>>(
    `/session/${encodeURIComponent(sessionId)}/diff`,
    init
  );
}

// Create a new session scoped to `directory`. Returns the new session — the
// caller can then POST a first prompt to it via postSessionMessageBrowser.
export async function createSessionBrowser(
  directory: string,
  title?: string,
  init: RequestInit = {}
): Promise<OpencodeSession> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await fetch(`/api/opencode/session?${qs}`, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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

// Cancels any in-flight model turn for this session. Opencode's abort is a
// soft cancel — already-committed tool calls finish, but no further reasoning
// or tool invocations fire. Returns when the server acknowledges.
export async function abortSessionBrowser(
  sessionId: string,
  directory: string,
  init: RequestInit = {}
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await fetch(
    `/api/opencode/session/${encodeURIComponent(sessionId)}/abort?${qs}`,
    {
      ...init,
      method: 'POST',
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode abort -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
}

// Typed error for the cost-cap gate (DESIGN.md §9 — see
// app/api/opencode/[...path]/route.ts). We split this out from the generic
// prompt-failure path because the UI needs the structured body (run id,
// accumulated $, declared cap) to render the banner and link to the routing
// modal. Callers `instanceof`-check this before falling back to generic logs.
export class CostCapError extends Error {
  readonly kind = 'cost-cap' as const;
  swarmRunID: string;
  costTotal: number;
  costCap: number;
  constructor(payload: { swarmRunID: string; costTotal: number; costCap: number; message?: string }) {
    super(payload.message ?? 'swarm run hit its cost cap');
    this.name = 'CostCapError';
    this.swarmRunID = payload.swarmRunID;
    this.costTotal = payload.costTotal;
    this.costCap = payload.costCap;
  }
}

// Fire-and-forget prompt submission. Uses /prompt_async so the composer doesn't
// block on the full model turn — SSE surfaces parts as they stream in.
// Instance-scoped via ?directory=, same as every other instance route.
//
// `agent` is the opencode agent-config name (e.g. "build", "plan"). When set,
// opencode routes this prompt to that agent-config within the session instead
// of the session's default. Omit to broadcast to the session's lead agent.
//
// Throws CostCapError on 402 (swarm cost-cap gate fired) so callers can
// render a structured banner; other failures throw a generic Error with the
// HTTP status and response detail.
export async function postSessionMessageBrowser(
  sessionId: string,
  directory: string,
  text: string,
  // #7.Q37 — `agent` typed as the built-in set. Passing a custom role
  // label (e.g. 'orchestrator', 'judge') would have opencode silently
  // 204 the POST; the type now catches that at compile time.
  opts: { agent?: OpencodeBuiltinAgent } = {},
  init: RequestInit = {}
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text }],
  };
  if (opts.agent) body.agent = opts.agent;
  const res = await fetch(
    `/api/opencode/session/${encodeURIComponent(sessionId)}/prompt_async?${qs}`,
    {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 402 && detail) {
      try {
        const parsed = JSON.parse(detail) as {
          swarmRunID?: string;
          costTotal?: number;
          costCap?: number;
          message?: string;
        };
        if (
          typeof parsed.swarmRunID === 'string' &&
          typeof parsed.costTotal === 'number' &&
          typeof parsed.costCap === 'number'
        ) {
          throw new CostCapError({
            swarmRunID: parsed.swarmRunID,
            costTotal: parsed.costTotal,
            costCap: parsed.costCap,
            message: parsed.message,
          });
        }
      } catch (err) {
        if (err instanceof CostCapError) throw err;
        // malformed 402 body — fall through to the generic error below
      }
    }
    throw new OpencodeHttpError('prompt', res.status, detail || undefined);
  }
}

// Permissions endpoints. opencode emits `permission.updated` when a tool
// call needs approval (and again when scope/metadata changes), and
// `permission.replied` when the user resolves it. Instance-scoped like
// every other route — GET/POST both require ?directory=.
//
// Endpoint shape changed in v1.14: the canonical reply path is
// `POST /session/{id}/permissions/{permissionID}` with body
// `{ response: 'once' | 'always' | 'reject' }`. The legacy
// `POST /permission/{id}/reply` (body `{ reply }`) was removed.
export function getPendingPermissionsBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodePermissionRequest[]> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodePermissionRequest[]>(`/permission?${qs}`, init);
}

export async function replyPermissionBrowser(
  sessionID: string,
  permissionID: string,
  directory: string,
  response: OpencodePermissionReply,
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await fetch(
    `/api/opencode/session/${encodeURIComponent(sessionID)}/permissions/${encodeURIComponent(permissionID)}?${qs}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode permission reply -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
}

// Per-session diff query key. Includes lastUpdated so each new turn
// produces a fresh cache entry — the upstream session diff is
// immutable for a given turn-completion timestamp, so a stale-time
// of effectively-forever per (session, lastUpdated) is correct.
export function sessionDiffQueryKey(
  sessionId: string,
  lastUpdated: number,
): readonly unknown[] {
  return ['opencode', 'session', sessionId, 'diff', lastUpdated];
}

// ---------------------------------------------------------------------------
// v1.14 supplementary surfaces. Each is directory-scoped (?directory=) like
// every other instance route. None of these fire on the streaming path —
// they're typically polled on demand from inspector/diagnostic surfaces.

// Live tool-name catalog from the running daemon. Includes built-ins +
// user-installed skills + the `invalid` sentinel. Use to cross-check that
// our static `ToolName` union still matches what the daemon advertises.
export function getToolIdsBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeToolIds> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodeToolIds>(`/experimental/tool/ids?${qs}`, init);
}

// Effective opencode.json — theme, watcher ignores, share policy,
// user-defined commands, plugin list, etc. Useful for diagnostics modals.
export function getConfigBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeConfig> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodeConfig>(`/config?${qs}`, init);
}

// MCP server status map (keyed by server name). Each entry is a tagged
// union — `type: 'connected' | 'disabled' | 'failed' | 'needs-auth' |
// 'needs-client-registration'`.
export function getMcpStatusBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeMcpStatusMap> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodeMcpStatusMap>(`/mcp?${qs}`, init);
}

// User-defined commands from opencode.json (init, review, …). Useful for
// a one-shot operations picker.
export function getCommandsBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeCommand[]> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodeCommand[]>(`/command?${qs}`, init);
}

// Direct child sessions of a session (sub-agent forks). Returned shape is
// `Session[]`. Callers can recurse to build a lineage tree.
export function getSessionChildrenBrowser(
  sessionId: string,
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeSession[]> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodeSession[]>(
    `/session/${encodeURIComponent(sessionId)}/children?${qs}`,
    init
  );
}

// Session-scoped todo list — what the agent's `todowrite` tool last
// committed. Independent of our blackboard plan; useful as a cross-check.
export function getSessionTodoBrowser(
  sessionId: string,
  directory: string,
  init: RequestInit = {}
): Promise<OpencodeTodo[]> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodeTodo[]>(
    `/session/${encodeURIComponent(sessionId)}/todo?${qs}`,
    init
  );
}

// Manually trigger summarization for a session — cheaper than waiting for
// opencode's automatic compaction at context-cap. Body is the model to use
// for the summarization turn.
export async function postSessionSummarizeBrowser(
  sessionId: string,
  directory: string,
  providerID: string,
  modelID: string,
  init: RequestInit = {}
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await fetch(
    `/api/opencode/session/${encodeURIComponent(sessionId)}/summarize?${qs}`,
    {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: JSON.stringify({ providerID, modelID }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode session summarize -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
}
