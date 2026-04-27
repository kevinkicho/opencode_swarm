'use client';

//
// Permission-request observation + reply hook. opencode emits
// `permission.asked` when a tool call needs approval and blocks the
// tool until `permission.replied` resolves it. Hydrates via GET on mount
// then mutates local state from SSE — no refetch needed because the
// asked event carries the full Request payload.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { OpencodePermissionRequest } from '../types';
import {
  getPendingPermissionsBrowser,
  replyPermissionBrowser,
} from './_fetchers';

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
