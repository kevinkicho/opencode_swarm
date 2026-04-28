'use client';

//
// Permission-request observation + reply hook. v1.14 contract:
//   - `permission.updated` — fires when a permission request is created
//     (the asked state) or its metadata mutates. Carries the full
//     Permission record, so we can mutate local state from the event
//     payload alone — no refetch needed.
//   - `permission.replied` — fires when the user resolves the request.
//     Carries `{ sessionID, permissionID, response }`.
// The pre-v1.14 `permission.asked` event was retired; the asked state
// now arrives via `permission.updated` (see docs/opencode-quirks.md §1).

import { useCallback, useEffect, useRef, useState } from 'react';

import type { OpencodePermissionRequest } from '../types';
import {
  getPendingPermissionsBrowser,
  replyPermissionBrowser,
} from './_fetchers';

export interface LivePermissions {
  pending: OpencodePermissionRequest[];
  approve: (permissionID: string, scope: 'once' | 'always') => Promise<void>;
  reject: (permissionID: string) => Promise<void>;
  error: string | null;
}

// Tracks pending permission requests for one session. Hydrates via GET on
// mount, then mutates local state from SSE `permission.updated` /
// `permission.replied` — no refetch needed because the updated event
// carries the full Permission record.
export function useLivePermissions(
  sessionId: string | null,
  directory: string | null
): LivePermissions {
  const [pending, setPending] = useState<OpencodePermissionRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const directoryRef = useRef<string | null>(directory);
  const sessionIdRef = useRef<string | null>(sessionId);
  directoryRef.current = directory;
  sessionIdRef.current = sessionId;

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
        if (parsed.type === 'permission.updated') {
          const req = parsed.properties as OpencodePermissionRequest;
          if (req.sessionID !== sessionId) return;
          setPending((prev) => {
            const idx = prev.findIndex((p) => p.id === req.id);
            if (idx === -1) return [...prev, req];
            // metadata-only updates (scope flip, etc.) overwrite the
            // existing entry in place
            const next = prev.slice();
            next[idx] = req;
            return next;
          });
        } else if (parsed.type === 'permission.replied') {
          const payload = parsed.properties as {
            sessionID: string;
            permissionID: string;
            response?: string;
          };
          if (payload.sessionID !== sessionId) return;
          setPending((prev) => prev.filter((p) => p.id !== payload.permissionID));
        }
      } catch {
        // server.connected / heartbeat / disposed frames — ignore
      }
    };

    return () => {
      cancelled = true;
      controller.abort();
      es.close();
    };
  }, [sessionId, directory]);

  const approve = useCallback(
    async (permissionID: string, scope: 'once' | 'always') => {
      const dir = directoryRef.current;
      const sid = sessionIdRef.current;
      if (!dir || !sid) return;
      // optimistic remove — the replied event will confirm, and if the POST
      // fails we surface the error and put it back
      const snapshot = pending;
      setPending((prev) => prev.filter((p) => p.id !== permissionID));
      try {
        await replyPermissionBrowser(sid, permissionID, dir, scope);
      } catch (err) {
        setError((err as Error).message);
        setPending(snapshot);
      }
    },
    [pending]
  );

  const reject = useCallback(
    async (permissionID: string) => {
      const dir = directoryRef.current;
      const sid = sessionIdRef.current;
      if (!dir || !sid) return;
      const snapshot = pending;
      setPending((prev) => prev.filter((p) => p.id !== permissionID));
      try {
        await replyPermissionBrowser(sid, permissionID, dir, 'reject');
      } catch (err) {
        setError((err as Error).message);
        setPending(snapshot);
      }
    },
    [pending]
  );

  return { pending, approve, reject, error };
}
