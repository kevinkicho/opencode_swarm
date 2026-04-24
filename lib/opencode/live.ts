'use client';

// Browser-side opencode client. Talks to our Next.js proxy at `/api/opencode/*`
// — the proxy injects Basic auth server-side, so no credentials ship here.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  OpencodeMessage,
  OpencodePermissionReply,
  OpencodePermissionRequest,
  OpencodeProject,
  OpencodeSession,
} from './types';
import type {
  SwarmRunEvent,
  SwarmRunListRow,
  SwarmRunMeta,
} from '../swarm-run-types';

async function getJsonBrowser<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/opencode${path}`, { ...init, cache: 'no-store' });
  if (!res.ok) throw new Error(`opencode ${path} -> HTTP ${res.status}`);
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

// Session-aggregate diff. Opencode returns one entry per changed file with a
// unified-diff string spanning the whole session. Note: ?messageID= and ?hash=
// are accepted by opencode but ignored (probed 2026-04-20), so per-turn
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
  opts: { agent?: string } = {},
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
    throw new Error(`opencode prompt -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

export interface LiveSnapshot {
  projects: OpencodeProject[];
  sessions: OpencodeSession[];
  lastUpdated: number;
}

export type HealthStatus = 'live' | 'offline' | 'checking';

export interface HealthSnapshot {
  status: HealthStatus;
  projectCount: number;
  lastChecked: number;
  error?: string;
}

// Lightweight health probe — single request to /project, cheap enough to poll
// every few seconds as a background heartbeat for the prototype's footer.
export function useOpencodeHealth(intervalMs = 5000): HealthSnapshot {
  const [state, setState] = useState<HealthSnapshot>({
    status: 'checking',
    projectCount: 0,
    lastChecked: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();

    async function check() {
      controller.abort();
      controller = new AbortController();
      try {
        const projects = await getProjectsBrowser({ signal: controller.signal });
        if (cancelled) return;
        setState({
          status: 'live',
          projectCount: projects.length,
          lastChecked: Date.now(),
        });
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setState({
          status: 'offline',
          projectCount: 0,
          lastChecked: Date.now(),
          error: (err as Error).message,
        });
      }
    }

    check();
    const id = setInterval(check, intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}

// Shared "is the backend reachable right now?" hook. Wraps
// useOpencodeHealth with a staleness-debounce so a single transient
// failure doesn't flicker every dependent chip. Any chip that wants
// to gray out when the dev server / proxy is down can call this.
//
// Staleness rule: requires at least two consecutive 'offline' health
// readings before returning true. At the default 5 s poll interval
// that's ~5 s of downtime before UI goes stale — fast enough to be
// felt, slow enough to tolerate a single failed request.
//
// Cost note: each caller opens its own 5 s poll. At prototype scale
// the overhead is trivial; if we ever need to share one instance,
// wrap this in a Context provider.
export function useBackendStale(): boolean {
  const health = useOpencodeHealth(5_000);
  const [stale, setStale] = useState(false);
  const offlineStreakRef = useRef(0);
  useEffect(() => {
    if (health.status === 'offline') {
      offlineStreakRef.current += 1;
      if (offlineStreakRef.current >= 2) setStale(true);
    } else {
      offlineStreakRef.current = 0;
      if (stale) setStale(false);
    }
  }, [health.status, stale]);
  return stale;
}

export interface LiveSessionSnapshot {
  session: OpencodeSession | null;
  messages: OpencodeMessage[];
  lastUpdated: number;
}

// SSE-driven live view of one session. Initial REST fetch establishes baseline,
// then /api/opencode/event triggers refetches as message/session events arrive.
// A 30s safety poll catches any dropped-stream edge cases. Pass null to skip.
export function useLiveSession(
  sessionId: string | null,
  fallbackPollMs = 30_000
): {
  data: LiveSessionSnapshot | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<LiveSessionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let pendingRefetch = false;
    let controller = new AbortController();
    let currentDirectory: string | null = null;
    let es: EventSource | null = null;

    // Opencode's /event route is instance-scoped by ?directory=<path>
    // (see opencode src: routes/instance/middleware.ts). Without the param it
    // falls back to process.cwd(), which is why anonymous SSE subs only see
    // heartbeats — POSTs from the web UI bind to a different instance. So we
    // fetch the session first to learn its directory, then scope the stream.
    const openStream = (directory: string) => {
      if (es) es.close();
      const qs = new URLSearchParams({ directory }).toString();
      es = new EventSource(`/api/opencode/event?${qs}`);
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as {
            type?: string;
            properties?: { sessionID?: string };
          };
          if (parsed.properties?.sessionID !== sessionId) return;
          refetch();
        } catch {
          // heartbeat / connected frames — ignore
        }
      };
    };

    async function refetch() {
      if (pendingRefetch) return;
      pendingRefetch = true;
      controller.abort();
      controller = new AbortController();
      try {
        const [sessions, messages] = await Promise.all([
          getAllSessionsBrowser({ signal: controller.signal }),
          getSessionMessagesBrowser(sessionId!, { signal: controller.signal }),
        ]);
        if (cancelled) return;
        const session = sessions.find((s) => s.id === sessionId) ?? null;
        setData({ session, messages, lastUpdated: Date.now() });
        setError(null);
        if (session?.directory && session.directory !== currentDirectory) {
          currentDirectory = session.directory;
          openStream(session.directory);
        }
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        pendingRefetch = false;
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    refetch();

    // Safety net: if the stream drops or an event is missed, still catch up.
    const pollId = setInterval(refetch, fallbackPollMs);

    return () => {
      cancelled = true;
      controller.abort();
      if (es) es.close();
      clearInterval(pollId);
    };
  }, [sessionId, fallbackPollMs]);

  return { data, error, loading };
}

// Lazy diff fetch: only runs when `enabled` flips true (e.g. when the drawer
// opens). Refetches when the session's lastUpdated changes so edits from a
// newly-finished turn appear without a manual refresh.
export function useSessionDiff(
  sessionId: string | null,
  enabled: boolean,
  lastUpdated: number | null
): {
  diffs: Array<{ file: string; patch: string }> | null;
  error: string | null;
  loading: boolean;
} {
  const [diffs, setDiffs] = useState<Array<{ file: string; patch: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId || !enabled) {
      setDiffs(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    getSessionDiffBrowser(sessionId, { signal: controller.signal })
      .then((rows) => {
        if (cancelled) return;
        setDiffs(rows);
        setError(null);
      })
      .catch((err) => {
        if (cancelled || (err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sessionId, enabled, lastUpdated]);

  return { diffs, error, loading };
}

// Polling hook — fires immediately, then every `intervalMs`. Aborts the in-flight
// request on unmount / interval-change. Never shows stale data with a new error.
export function useLiveSessions(intervalMs = 3000): {
  data: LiveSnapshot | null;
  error: string | null;
  loading: boolean;
} {
  const [data, setData] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();

    async function poll() {
      controller.abort();
      controller = new AbortController();
      try {
        const [projects, sessions] = await Promise.all([
          getProjectsBrowser({ signal: controller.signal }),
          getAllSessionsBrowser({ signal: controller.signal }),
        ]);
        if (cancelled) return;
        setData({ projects, sessions, lastUpdated: Date.now() });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [intervalMs]);

  return { data, error, loading };
}

// --- Permissions ---------------------------------------------------------
// opencode emits `permission.asked` when a tool call needs approval and blocks
// the tool until `permission.replied` resolves it. Instance-scoped like every
// other instance route — GET/POST both require ?directory=.

export function getPendingPermissionsBrowser(
  directory: string,
  init: RequestInit = {}
): Promise<OpencodePermissionRequest[]> {
  const qs = new URLSearchParams({ directory }).toString();
  return getJsonBrowser<OpencodePermissionRequest[]>(`/permission?${qs}`, init);
}

export async function replyPermissionBrowser(
  requestID: string,
  directory: string,
  reply: OpencodePermissionReply,
  message?: string
): Promise<void> {
  const qs = new URLSearchParams({ directory }).toString();
  const res = await fetch(
    `/api/opencode/permission/${encodeURIComponent(requestID)}/reply?${qs}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message ? { reply, message } : { reply }),
    }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `opencode permission reply -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
    );
  }
}

export interface LivePermissions {
  pending: OpencodePermissionRequest[];
  approve: (requestID: string, scope: 'once' | 'always') => Promise<void>;
  reject: (requestID: string, message?: string) => Promise<void>;
  error: string | null;
}

// Tracks pending permission requests for one session. Hydrates via GET on
// mount, then mutates local state from SSE `permission.asked` / `permission.replied`
// — no refetch needed because the asked event carries the full Request payload.
export function useLivePermissions(
  sessionId: string | null,
  directory: string | null
): LivePermissions {
  const [pending, setPending] = useState<OpencodePermissionRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const directoryRef = useRef<string | null>(directory);
  directoryRef.current = directory;

  useEffect(() => {
    if (!sessionId || !directory) {
      setPending([]);
      setError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    getPendingPermissionsBrowser(directory, { signal: controller.signal })
      .then((rows) => {
        if (cancelled) return;
        setPending(rows.filter((r) => r.sessionID === sessionId));
      })
      .catch((err) => {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      });

    const qs = new URLSearchParams({ directory }).toString();
    const es = new EventSource(`/api/opencode/event?${qs}`);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as {
          type?: string;
          properties?: unknown;
        };
        if (parsed.type === 'permission.asked') {
          const req = parsed.properties as OpencodePermissionRequest;
          if (req.sessionID !== sessionId) return;
          setPending((prev) =>
            prev.some((p) => p.id === req.id) ? prev : [...prev, req]
          );
        } else if (parsed.type === 'permission.replied') {
          const payload = parsed.properties as {
            sessionID: string;
            requestID: string;
          };
          if (payload.sessionID !== sessionId) return;
          setPending((prev) => prev.filter((p) => p.id !== payload.requestID));
        }
      } catch {
        // heartbeats / connected frames — ignore
      }
    };

    return () => {
      cancelled = true;
      controller.abort();
      es.close();
    };
  }, [sessionId, directory]);

  const approve = useCallback(
    async (requestID: string, scope: 'once' | 'always') => {
      const dir = directoryRef.current;
      if (!dir) return;
      // optimistic remove — the replied event will confirm, and if the POST
      // fails we surface the error and put it back
      const snapshot = pending;
      setPending((prev) => prev.filter((p) => p.id !== requestID));
      try {
        await replyPermissionBrowser(requestID, dir, scope);
      } catch (err) {
        setError((err as Error).message);
        setPending(snapshot);
      }
    },
    [pending]
  );

  const reject = useCallback(
    async (requestID: string, message?: string) => {
      const dir = directoryRef.current;
      if (!dir) return;
      const snapshot = pending;
      setPending((prev) => prev.filter((p) => p.id !== requestID));
      try {
        await replyPermissionBrowser(requestID, dir, 'reject', message);
      } catch (err) {
        setError((err as Error).message);
        setPending(snapshot);
      }
    },
    [pending]
  );

  return { pending, approve, reject, error };
}

// ─── swarm-run ────────────────────────────────────────────────────────────
//
// A "swarm run" is one logical run wrapping N opencode sessions under a
// single coordinator (see SWARM_PATTERNS.md). At v1 N=1 and
// pattern='none', so this hook is effectively a thin resolver: given a
// swarmRunID, it fetches meta.json and exposes the primary sessionID +
// workspace so the existing single-session hooks can drive the UI unchanged.
//
// The hook also maintains a live connection to the multiplexed event stream
// so future panels (swarm-wide provenance log, cross-session coordination
// chips) can read recent events without each of them opening their own
// EventSource. For pattern='none' the stream is strictly additive — all the
// same events are already flowing through useLiveSessionMessages' per-session
// EventSource. We dedupe by letting the consumer decide which stream to
// read; this hook just surfaces both channels.

export interface LiveSwarmRunSnapshot {
  meta: SwarmRunMeta | null;
  loading: boolean;
  error: string | null;
  // Dedicated 404 flag so callers can show a "run not found" surface
  // instead of conflating it with transient network / server errors.
  // This matters because a dead swarmRunID in the URL is a permanent
  // state — retrying won't help, and silently falling back to mock data
  // (which is what the page used to do) hides the broken link.
  notFound: boolean;
  // At v1 the primary session is sessionIDs[0]. Exposed separately so the
  // page doesn't need to poke into meta.sessionIDs for the 95% common case.
  primarySessionID: string | null;
  workspace: string | null;
}

export function useLiveSwarmRun(swarmRunID: string | null): LiveSwarmRunSnapshot {
  const [meta, setMeta] = useState<SwarmRunMeta | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(swarmRunID));
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<boolean>(false);

  useEffect(() => {
    if (!swarmRunID) {
      setMeta(null);
      setLoading(false);
      setError(null);
      setNotFound(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setNotFound(false);

    fetch(`/api/swarm/run/${encodeURIComponent(swarmRunID)}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        // 404 is terminal for this swarmRunID — surface it as notFound so
        // the page can render a dedicated screen. Every other non-ok
        // response is an error (transient or server-side) and stays in
        // the `error` channel.
        if (res.status === 404) {
          if (!cancelled) {
            setNotFound(true);
            setMeta(null);
            setLoading(false);
          }
          return null;
        }
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(
            `swarm run lookup -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
          );
        }
        return (await res.json()) as SwarmRunMeta;
      })
      .then((row) => {
        if (cancelled || row === null) return;
        setMeta(row);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [swarmRunID]);

  return {
    meta,
    loading,
    error,
    notFound,
    primarySessionID: meta?.sessionIDs[0] ?? null,
    workspace: meta?.workspace ?? null,
  };
}

// Live view across every session in a swarm run. Where useLiveSession binds
// one EventSource to one sessionID, this hook fans across meta.sessionIDs —
// the council preset's N parallel seed-identical members, or any future
// multi-session pattern. Pattern='none' degenerates to a one-slot snapshot
// so the same consumer code works for both.
//
// Architecture:
//   - Initial hydrate  — one getSessionsByDirectoryBrowser(workspace) call
//     (cheap, scoped) plus N getSessionMessagesBrowser calls in parallel.
//     Cheaper than useLiveSession's getAllSessionsBrowser because we
//     already know the workspace from meta and can skip the project
//     fan-out entirely.
//   - Live stream      — ONE opencode /event EventSource scoped by
//     ?directory=<workspace>. All council members share a workspace, so
//     they share a stream. On each event we check properties.sessionID
//     against the meta's sessionID set and refetch just that slot's
//     messages, keeping bandwidth proportional to real activity.
//   - Safety poll      — same 30s safety net as useLiveSession; catches
//     dropped streams by refetching every slot.
//
// Per-slot probe failures collapse to empty messages + null session — the
// slot stays in place so the consumer can still render a spinner or empty
// lane for it. A thrown refetch surfaces in the shared `error` channel.
//
// Not wired into app/page.tsx at S3 — that's S5's job after S4 rekeys the
// agent transform on sessionID. Call this today from multi-session surfaces
// (run-provenance drawer, future council lane view) where the per-session
// partition is the value, not an implementation detail.
export interface LiveSwarmSessionSlot {
  sessionID: string;
  // The OpencodeSession for this member, or null if the directory-scoped
  // session list didn't include it (race on newly-created sessions, or the
  // session was deleted out from under us). Consumers should tolerate null
  // rather than hide the slot — the sessionID itself is authoritative.
  session: OpencodeSession | null;
  messages: OpencodeMessage[];
  lastUpdated: number;
}

export interface LiveSwarmRunMessagesSnapshot {
  // Same order as meta.sessionIDs. Consumers that want per-member lanes
  // render in this order; consumers that want a merged transcript can
  // flatten + sort by message time downstream.
  slots: LiveSwarmSessionSlot[];
  loading: boolean;
  error: string | null;
  // Max(slot.lastUpdated). Null when no slot has hydrated yet.
  lastUpdated: number | null;
}

export function useLiveSwarmRunMessages(
  meta: SwarmRunMeta | null,
  fallbackPollMs = 30_000
): LiveSwarmRunMessagesSnapshot {
  const [slots, setSlots] = useState<LiveSwarmSessionSlot[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(meta));
  const [error, setError] = useState<string | null>(null);

  // Stable key for the effect: swarmRunID is unique, workspace pins the SSE
  // directory, and the sessionIDs list is immutable for a given run (meta.json
  // is write-once). Joining on a separator that can't appear in opencode IDs
  // keeps this dep cheap + referentially stable across renders.
  const swarmRunID = meta?.swarmRunID ?? null;
  const workspace = meta?.workspace ?? null;
  const sessionIDsKey = meta?.sessionIDs.join('|') ?? '';

  useEffect(() => {
    if (!meta || !workspace || meta.sessionIDs.length === 0) {
      setSlots([]);
      setLoading(false);
      setError(null);
      return;
    }

    const sessionIDs = meta.sessionIDs;
    const sessionSet = new Set(sessionIDs);

    let cancelled = false;
    const controller = new AbortController();
    let es: EventSource | null = null;
    // Coalesce per-slot refetches. SSE can burst many part.updated events
    // during a single assistant turn — with 6 workers active each emitting
    // events every ~100ms, naive per-event refetch triggers near-constant
    // full-history fetches that dominate hydration time.
    //
    // Strategy: cooldown-with-trailing. After a refetch completes, open a
    // COOLDOWN_MS window. Any event during cooldown doesn't fire a new
    // refetch immediately; it sets the "dirty" flag for that session. When
    // the cooldown elapses, if dirty, fire exactly one trailing refetch.
    // Keeps the latency bounded (~COOLDOWN_MS + network) while cutting
    // server fan-in by ~10x on busy runs.
    const inFlight = new Set<string>();
    const cooldownUntil = new Map<string, number>();
    const dirty = new Set<string>();
    const trailingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const COOLDOWN_MS = 2000;

    async function hydrate() {
      try {
        const [directorySessions, messagesArrays] = await Promise.all([
          getSessionsByDirectoryBrowser(workspace!, {
            signal: controller.signal,
          }).catch(() => [] as OpencodeSession[]),
          Promise.all(
            sessionIDs.map((sid) =>
              getSessionMessagesBrowser(sid, { signal: controller.signal }).catch(
                () => [] as OpencodeMessage[]
              )
            )
          ),
        ]);
        if (cancelled) return;

        const sessionById = new Map(directorySessions.map((s) => [s.id, s]));
        const ts = Date.now();
        const next: LiveSwarmSessionSlot[] = sessionIDs.map((sid, i) => ({
          sessionID: sid,
          session: sessionById.get(sid) ?? null,
          messages: messagesArrays[i],
          lastUpdated: ts,
        }));
        setSlots(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    async function doFetch(sessionID: string): Promise<void> {
      if (cancelled) return;
      if (inFlight.has(sessionID)) return;
      inFlight.add(sessionID);
      try {
        const messages = await getSessionMessagesBrowser(sessionID);
        if (cancelled) return;
        const ts = Date.now();
        setSlots((prev) => {
          const idx = prev.findIndex((s) => s.sessionID === sessionID);
          if (idx < 0) return prev;
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], messages, lastUpdated: ts };
          return copy;
        });
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        inFlight.delete(sessionID);
        cooldownUntil.set(sessionID, Date.now() + COOLDOWN_MS);
      }
    }

    // Called from SSE + fallback poll. Throttles: if within cooldown
    // window OR a fetch is in flight, sets dirty flag + arms a trailing
    // timer. Otherwise fetches immediately.
    function refetchOne(sessionID: string) {
      if (!sessionSet.has(sessionID) || cancelled) return;
      const cooldownExpiry = cooldownUntil.get(sessionID) ?? 0;
      const remaining = cooldownExpiry - Date.now();
      if (inFlight.has(sessionID) || remaining > 0) {
        dirty.add(sessionID);
        if (!trailingTimers.has(sessionID)) {
          const delay = Math.max(remaining, 50);
          trailingTimers.set(
            sessionID,
            setTimeout(() => {
              trailingTimers.delete(sessionID);
              if (!dirty.has(sessionID) || cancelled) return;
              dirty.delete(sessionID);
              refetchOne(sessionID);
            }, delay),
          );
        }
        return;
      }
      void doFetch(sessionID);
    }

    setLoading(true);
    hydrate();

    const qs = new URLSearchParams({ directory: workspace! }).toString();
    es = new EventSource(`/api/opencode/event?${qs}`);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as {
          type?: string;
          properties?: { sessionID?: string };
        };
        const sid = parsed.properties?.sessionID;
        if (!sid || !sessionSet.has(sid)) return;
        refetchOne(sid);
      } catch {
        // heartbeat / connected frames — ignore
      }
    };

    const pollId = setInterval(() => {
      for (const sid of sessionIDs) refetchOne(sid);
    }, fallbackPollMs);

    return () => {
      cancelled = true;
      controller.abort();
      if (es) es.close();
      clearInterval(pollId);
      for (const t of trailingTimers.values()) clearTimeout(t);
      trailingTimers.clear();
    };
    // The individual fields are stable-by-construction for a given meta.json;
    // splitting the dep array keeps React from tearing the effect down on
    // every re-render where meta is a fresh object with the same contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swarmRunID, workspace, sessionIDsKey, fallbackPollMs]);

  const lastUpdated = slots.length
    ? Math.max(...slots.map((s) => s.lastUpdated))
    : null;

  return { slots, loading, error, lastUpdated };
}

// Stream of run-level events. Consumes GET /api/swarm/run/:id/events and
// accumulates both the L0 replay (replayed SwarmRunEvents tagged replay:true)
// and the live feed. The control frames `swarm.run.attached`,
// `swarm.run.replay.start`, `swarm.run.replay.end`, `swarm.run.error` drive
// the `phase` state machine but are not surfaced as events themselves.
//
// Use this instead of useLiveSession when you need a cross-session view of
// a run — e.g. the run-provenance drawer. For a single-session drill-down,
// useLiveSession is still cheaper (it hydrates message history from
// /session/{id}/message instead of replaying every tagged event).

export type SwarmRunPhase =
  | 'idle'         // no swarmRunID or not yet connected
  | 'attached'     // handshake received, replay not yet started
  | 'replaying'    // streaming historical events from L0
  | 'live'         // replay complete, receiving live opencode events
  | 'error';       // upstream threw; `events` still holds what we got

export interface SwarmRunEventRow extends SwarmRunEvent {
  // Present on rows emitted during the replay phase. Absent on live rows.
  replay?: boolean;
}

export interface SwarmRunEventsSnapshot {
  events: SwarmRunEventRow[];
  phase: SwarmRunPhase;
  replayCount: number;   // what the server reported at replay.end
  error: string | null;
}

export function useSwarmRunEvents(
  swarmRunID: string | null
): SwarmRunEventsSnapshot {
  const [events, setEvents] = useState<SwarmRunEventRow[]>([]);
  const [phase, setPhase] = useState<SwarmRunPhase>('idle');
  const [replayCount, setReplayCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmRunID) {
      setEvents([]);
      setPhase('idle');
      setReplayCount(0);
      setError(null);
      return;
    }

    setEvents([]);
    setPhase('attached');
    setReplayCount(0);
    setError(null);

    const es = new EventSource(
      `/api/swarm/run/${encodeURIComponent(swarmRunID)}/events`
    );
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as {
          type?: string;
          properties?: unknown;
          replay?: boolean;
          ts?: number;
          sessionID?: string;
          swarmRunID?: string;
        };

        // Control frames drive the phase machine.
        if (parsed.type === 'swarm.run.attached') {
          setPhase('replaying');
          return;
        }
        if (parsed.type === 'swarm.run.replay.start') {
          setPhase('replaying');
          return;
        }
        if (parsed.type === 'swarm.run.replay.end') {
          const count = Number(
            (parsed.properties as { count?: number } | undefined)?.count ?? 0
          );
          setReplayCount(count);
          setPhase('live');
          return;
        }
        if (parsed.type === 'swarm.run.error') {
          const msg =
            (parsed.properties as { message?: string } | undefined)?.message ??
            'stream error';
          setError(msg);
          setPhase('error');
          return;
        }

        // Everything else is a tagged SwarmRunEvent (has ts + sessionID +
        // swarmRunID). Keep replay rows and live rows in the same array,
        // ordered by arrival — the server guarantees replay order first.
        if (
          typeof parsed.ts === 'number' &&
          typeof parsed.sessionID === 'string' &&
          typeof parsed.swarmRunID === 'string'
        ) {
          const row = parsed as SwarmRunEventRow;
          setEvents((prev) => [...prev, row]);
        }
      } catch {
        // Ignore malformed frames — the server shouldn't emit these but a
        // proxy / buffering edge case could split a JSON payload.
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transport errors; we only surface
      // the state change. If the server returned 404 the connection closes
      // permanently — phase stays 'error' and the caller (useLiveSwarmRun)
      // will also have seen the 404 on its meta lookup.
      setPhase((prev) => (prev === 'live' ? 'live' : 'error'));
    };

    return () => {
      es.close();
    };
  }, [swarmRunID]);

  return { events, phase, replayCount, error };
}

// Polling list of every persisted swarm run. Drives the status-rail runs
// picker. Shape mirrors useLiveSessions so the picker component can be
// structured the same way — a wide dense-row popover with filter + sort.
//
// Why poll vs subscribe: registry writes are rare (once per run create) and
// the existing SSE machinery is scoped to one run, not the whole ledger. A
// short poll keeps the picker fresh without plumbing a global event stream.

export interface SwarmRunsSnapshot {
  // Rows carry the persisted meta plus a live-derived status. Consumers
  // that only care about meta can read `row.meta`; consumers that want to
  // color-code by status read `row.status`.
  rows: SwarmRunListRow[];
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
}

export function useSwarmRuns(intervalMs = 4000): SwarmRunsSnapshot {
  const [rows, setRows] = useState<SwarmRunListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller = new AbortController();

    async function poll() {
      controller.abort();
      controller = new AbortController();
      try {
        const res = await fetch('/api/swarm/run', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(
            `swarm run list -> HTTP ${res.status}${detail ? `: ${detail}` : ''}`
          );
        }
        const body = (await res.json()) as { runs?: SwarmRunListRow[] };
        if (cancelled) return;
        setRows(body.runs ?? []);
        setLastUpdated(Date.now());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [intervalMs]);

  return { rows, error, loading, lastUpdated };
}
