'use client';

//
// Session-scoped supplementary hooks added in the v1.14 alignment:
//   - useLiveSessionChildren — direct sub-sessions for a parent session
//     (forks via `task` tool). Useful for rendering a lineage tree in
//     the inspector.
//   - useLiveSessionTodos — opencode's own session-scoped todo list
//     (what `todowrite` last committed). Distinct from our blackboard-
//     derived plan items; useful as a cross-check.
//
// Both are directory-scoped (?directory=). Pass null sessionId or
// directory to skip.

import { useQuery } from '@tanstack/react-query';

import {
  getSessionChildrenBrowser,
  getSessionTodoBrowser,
} from './_fetchers';
import type { OpencodeSession, OpencodeTodo } from '../types';

export const SESSION_CHILDREN_QUERY_KEY = ['opencode', 'session-children'] as const;
export const SESSION_TODO_QUERY_KEY = ['opencode', 'session-todo'] as const;

// Direct child sessions of a session. Returned as a flat list; callers
// recurse if they want the full subtree.
//
// 60s polling cadence (was 20s, was 5s before that). Children and todos
// rarely change — a new sub-session appears at most once per turn, and
// todo updates are infrequent. 60s is plenty to surface changes within
// a reasonable UX window without contending for connections during
// long-lived runs.
export function useLiveSessionChildren(
  sessionId: string | null,
  directory: string | null,
): {
  data: OpencodeSession[] | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: [...SESSION_CHILDREN_QUERY_KEY, sessionId ?? '', directory ?? ''] as const,
    queryFn: ({ signal }) =>
      getSessionChildrenBrowser(sessionId!, directory!, { signal }),
    enabled: Boolean(sessionId && directory),
    refetchInterval: 60_000,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}

// Session-scoped todo list — the agent's own `todowrite` snapshot. We
// surface it alongside the blackboard plan as a cross-check (when our
// plan differs from what the agent committed last, that's a bug
// indicator). Same 60s cadence as children for the same reason.
export function useLiveSessionTodos(
  sessionId: string | null,
  directory: string | null,
): {
  data: OpencodeTodo[] | null;
  error: string | null;
  loading: boolean;
} {
  const q = useQuery({
    queryKey: [...SESSION_TODO_QUERY_KEY, sessionId ?? '', directory ?? ''] as const,
    queryFn: ({ signal }) =>
      getSessionTodoBrowser(sessionId!, directory!, { signal }),
    enabled: Boolean(sessionId && directory),
    refetchInterval: 60_000,
    retry: false,
  });
  return {
    data: q.data ?? null,
    error: q.error ? (q.error as Error).message : null,
    loading: q.isLoading,
  };
}
