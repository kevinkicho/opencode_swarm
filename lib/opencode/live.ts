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
