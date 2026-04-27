'use client';

// HARDENING_PLAN.md#C10 — live.ts split.
//
// Single-session live hooks: useLiveSession (one session's messages +
// metadata, SSE-driven), useSessionDiff (lazy diff fetch, immutable per
// completed turn), useLiveSessions (poll-based list of every project's
// sessions for the picker).
//
// The TanStack Query cache key for messages is shared with
// useLiveSwarmRunMessages — the primary session in a swarm run is fetched
// ONCE across both hooks, with whichever finishes first populating the
// shared cache.

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  OpencodeMessage,
  OpencodeProject,
  OpencodeSession,
} from '../types';
import {
  getAllSessionsBrowser,
  getProjectsBrowser,
  getSessionBrowser,
  getSessionDiffBrowser,
  getSessionMessagesBrowser,
  sessionDiffQueryKey,
  sessionMessagesQueryKey,
} from './_fetchers';

export interface LiveSnapshot {
  projects: OpencodeProject[];
  sessions: OpencodeSession[];
  lastUpdated: number;
}

export interface LiveSessionSnapshot {
  session: OpencodeSession | null;
  messages: OpencodeMessage[];
  lastUpdated: number;
}

// SSE-driven live view of one session. Messages come from TanStack Query
// (shared cache with useLiveSwarmRunMessages — same sessionMessagesQueryKey,
// so the primary session is fetched ONCE even if both hooks are active on
// the same page). Session metadata + SSE subscription live in the effect
// since they're per-session and SSE integration needs imperative refs.
// Pass null to skip.
export function useLiveSession(
  sessionId: string | null,
  fallbackPollMs = 30_000
): {
  data: LiveSessionSnapshot | null;
  error: string | null;
  loading: boolean;
} {
  const [session, setSession] = useState<OpencodeSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const messagesQuery = useQuery({
    queryKey: sessionMessagesQueryKey(sessionId ?? ''),
    queryFn: () => getSessionMessagesBrowser(sessionId!),
    enabled: Boolean(sessionId),
    // Matches the old fallback-poll cadence; TanStack Query also
    // refetches on window-focus + reconnect from the provider defaults.
    refetchInterval: fallbackPollMs,
  });

  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setSessionError(null);
      return;
    }
    let cancelled = false;
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
          // Invalidate the messages query so TanStack Query refetches.
          // All consumers of this session's messages (including
          // useLiveSwarmRunMessages, if it overlaps) pick up the update.
          void queryClient.invalidateQueries({
            queryKey: sessionMessagesQueryKey(sessionId),
          });
        } catch {
          // heartbeat / connected frames — ignore
        }
      };
    };

    async function fetchSessionMeta() {
      controller.abort();
      controller = new AbortController();
      try {
        const meta = await getSessionBrowser(
          sessionId!,
          currentDirectory ?? undefined,
          { signal: controller.signal },
        );
        if (cancelled) return;
        setSession(meta);
        setSessionError(null);
        if (meta.directory && meta.directory !== currentDirectory) {
          currentDirectory = meta.directory;
          openStream(meta.directory);
        }
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === 'AbortError') return;
        setSessionError((err as Error).message);
      }
    }

    void fetchSessionMeta();

    return () => {
      cancelled = true;
      controller.abort();
      if (es) es.close();
    };
  }, [sessionId, queryClient]);

  const data = useMemo<LiveSessionSnapshot | null>(() => {
    if (!sessionId) return null;
    return {
      session,
      messages: messagesQuery.data ?? [],
      lastUpdated: messagesQuery.dataUpdatedAt || 0,
    };
  }, [sessionId, session, messagesQuery.data, messagesQuery.dataUpdatedAt]);

  const error =
    sessionError ||
    (messagesQuery.error ? (messagesQuery.error as Error).message : null);
  const loading = Boolean(sessionId) && messagesQuery.isLoading;

  return { data, error, loading };
}

// Lazy diff fetch: only runs when `enabled` flips true (e.g. when the
// drawer opens). Refetches when the session's lastUpdated changes so
// edits from a newly-finished turn appear without a manual refresh.
//
// Migrated to TanStack Query (IMPLEMENTATION_PLAN 6.3) — gives free
// cross-component dedup (multiple drawers / inspectors asking for the
// same diff share one cache entry) and automatic cache hits across
// drawer open/close cycles. Earlier custom implementation re-fetched
// on every effect re-run.
export function useSessionDiff(
  sessionId: string | null,
  enabled: boolean,
  lastUpdated: number | null
): {
  diffs: Array<{ file: string; patch: string }> | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: sessionDiffQueryKey(sessionId ?? '', lastUpdated ?? 0),
    queryFn: ({ signal }) =>
      getSessionDiffBrowser(sessionId!, { signal }),
    // Two gates: caller-driven `enabled` (drawer open) AND a non-null
    // sessionId. lastUpdated null is acceptable — represents "no turns
    // yet completed"; the queryKey just folds those into the same
    // cache slot ('diff', 0).
    enabled: enabled && !!sessionId,
    // Diffs for a (session, lastUpdated) pair are immutable. Long
    // staleTime → no spurious refetches when the same drawer reopens.
    staleTime: 5 * 60_000,
    retry: false,
  });
  return {
    diffs: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}

// Polling hook — fires immediately, then every `intervalMs`. TanStack
// Query handles the abort + cleanup automatically; multiple consumers
// share one cache entry. Never shows stale data with a new error
// because TanStack Query's keepPreviousData semantics are off by
// default for refetch.
//
// Migrated to TanStack Query (#109).
export function useLiveSessions(intervalMs = 3000): {
  data: LiveSnapshot | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: LIVE_SESSIONS_QUERY_KEY,
    queryFn: async ({ signal }): Promise<LiveSnapshot> => {
      const [projects, sessions] = await Promise.all([
        getProjectsBrowser({ signal }),
        getAllSessionsBrowser({ signal }),
      ]);
      return { projects, sessions, lastUpdated: Date.now() };
    },
    refetchInterval: intervalMs,
    placeholderData: (prev) => prev,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}

export const LIVE_SESSIONS_QUERY_KEY = ['opencode', 'live-sessions'] as const;
