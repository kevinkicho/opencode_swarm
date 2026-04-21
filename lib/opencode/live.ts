'use client';

// Browser-side opencode client. Talks to our Next.js proxy at `/api/opencode/*`
// — the proxy injects Basic auth server-side, so no credentials ship here.

import { useEffect, useState } from 'react';
import type {
  OpencodeMessage,
  OpencodeProject,
  OpencodeSession,
} from './types';

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
  const projects = await getProjectsBrowser(init);
  const batches = await Promise.all(
    projects.map((p) =>
      getSessionsByDirectoryBrowser(p.worktree, init).catch(
        () => [] as OpencodeSession[]
      )
    )
  );
  const seen = new Set<string>();
  const rows: OpencodeSession[] = [];
  for (const batch of batches) {
    for (const s of batch) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      rows.push(s);
    }
  }
  rows.sort((a, b) => b.time.updated - a.time.updated);
  return rows;
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
