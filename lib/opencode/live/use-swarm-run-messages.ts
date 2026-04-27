'use client';

// HARDENING_PLAN.md#C10 — live.ts split.
//
// Swarm-run-aware live hooks: useLiveSwarmRun (resolve a swarmRunID to
// its meta + primary session) and useLiveSwarmRunMessages (live view
// across every session in a swarm run, fanning across meta.sessionIDs).
//
// useLiveSwarmRunMessages is the heaviest hook in the file: it owns
// the SSE → per-session refetch coalescing + partial-merge fast path
// + visibility gating. The split keeps it cohesive (sessionID set,
// cooldown maps, applyLocally state machine) rather than fragmenting
// across helpers — the logic only makes sense as a unit.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type {
  OpencodeMessage,
  OpencodePart,
  OpencodeSession,
} from '../types';
import type { SwarmRunMeta } from '../../swarm-run-types';
import { validatePart } from '../validate-part';
import {
  getSessionMessagesBrowser,
  getSessionsByDirectoryBrowser,
  sessionMessagesQueryKey,
} from './_fetchers';

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
// Wired into app/page.tsx as `liveSlots` and threaded through every
// per-pattern rail (iterations / debate / council / map / phases / strategy
// / contracts / roles) plus the run-provenance drawer. Per-session partition
// is now the canonical view shape for multi-session patterns.
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
  fallbackPollMs = 30_000,
  // IMPLEMENTATION_PLAN 6.4 — per-session visibility gating.
  // When set, SSE events for sessionIDs NOT in this list skip the
  // refetch path. Hydrate still loads all sessions (cold-load needs
  // full state); subsequent updates for hidden sessions are dropped.
  // Used by the page when the user has narrowed focus (e.g., open
  // inspector on one session) so the other sessions stop polling
  // during the focus window. Undefined → all sessions visible
  // (preserves prior behavior).
  visibleSessionIDs?: readonly string[],
): LiveSwarmRunMessagesSnapshot {
  const [slots, setSlots] = useState<LiveSwarmSessionSlot[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(meta));
  const [error, setError] = useState<string | null>(null);

  // Visibility gate ref (6.4): live-updated each render so the SSE
  // event handler reads the latest visible set without re-running the
  // hook's main effect (which would re-arm SSE — needless churn).
  // null means "all visible" (preserves prior behavior).
  const visibleRef = useRef<Set<string> | null>(null);
  visibleRef.current = visibleSessionIDs
    ? new Set(visibleSessionIDs)
    : null;

  // Mirror every message update into the TanStack Query cache. Why: this
  // hook does the "messages for all N sessions in a run" heavy lifting;
  // useLiveSession does the "messages for ONE session" single-view case.
  // Before this mirror, the primary session was fetched twice on every
  // cold load — once by this hook's hydrate, once by useLiveSession's
  // initial refetch. With the mirror, whichever hook finishes first
  // populates the shared cache and the other reads it instantly.
  const queryClient = useQueryClient();

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
        // Mirror into the TanStack Query cache — useLiveSession on the
        // same session will read this instead of firing its own fetch.
        for (const slot of next) {
          queryClient.setQueryData(
            sessionMessagesQueryKey(slot.sessionID),
            slot.messages,
          );
        }
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
        // Mirror into shared cache so useLiveSession picks up this
        // session's refresh without its own fetch.
        queryClient.setQueryData(sessionMessagesQueryKey(sessionID), messages);
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
    //
    // Per-session visibility gate (6.4): skip when the sessionID isn't
    // in the visible set. The closure reads the latest visible set at
    // call time so a runtime visibility change takes effect on the
    // next event without re-arming the SSE connection.
    function refetchOne(sessionID: string) {
      if (!sessionSet.has(sessionID) || cancelled) return;
      if (visibleRef.current && !visibleRef.current.has(sessionID)) {
        // Hidden session — let the trailing-merge fast path keep slot
        // metadata fresh via applyLocally; skip the full refetch.
        return;
      }
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

    // Partial-merge fast path. When an SSE event carries the full
    // part or message-info payload, splice it directly into the local
    // buffer instead of triggering a full session-history refetch.
    // Cuts the common "turn streaming" burn pattern from O(messages)
    // per event to O(1) per event — the biggest win for
    // page-hydration slowness on long runs. Falls back to refetch
    // when the event doesn't carry enough, or when the message isn't
    // yet in our buffer (rare race on brand-new turns).
    function applyLocally(ev: MessageEvent, sid: string): boolean {
      let parsed: {
        type?: string;
        properties?: {
          sessionID?: string;
          messageID?: string;
          part?: OpencodePart;
          info?: OpencodeMessage['info'];
        };
      };
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return false;
      }
      const props = parsed.properties ?? {};
      if (parsed.type === 'message.part.updated') {
        const messageID = props.messageID;
        if (!messageID) return false;
        // HARDENING_PLAN.md#R2 — validate the part shape before merging.
        // Pre-fix the cast `props.part as OpencodePart` trusted whatever
        // opencode emitted; a new part type or missing required field
        // (Q34/Q42 class) silently corrupted the slot. Validator returns
        // ok=false + warns once on schema drift; we then fall through to
        // refetch (return false) so the slot reloads from the canonical
        // /message endpoint.
        const checked = validatePart(props.part);
        if (!checked.ok) return false;
        const part = checked.part;
        if (!part.id) return false;
        let applied = false;
        setSlots((prev) => {
          const idx = prev.findIndex((s) => s.sessionID === sid);
          if (idx < 0) return prev;
          const slot = prev[idx];
          const msgIdx = slot.messages.findIndex((m) => m.info.id === messageID);
          if (msgIdx < 0) return prev; // message not yet hydrated
          const msg = slot.messages[msgIdx];
          const partIdx = msg.parts.findIndex((p) => p.id === part.id);
          const nextParts =
            partIdx < 0
              ? [...msg.parts, part]
              : msg.parts.map((p, i) => (i === partIdx ? part : p));
          const nextMessages = slot.messages.map((m, i) =>
            i === msgIdx ? { ...m, parts: nextParts } : m,
          );
          const copy = prev.slice();
          copy[idx] = {
            ...slot,
            messages: nextMessages,
            lastUpdated: Date.now(),
          };
          applied = true;
          return copy;
        });
        return applied;
      }
      if (parsed.type === 'message.updated') {
        const info = props.info;
        if (!info?.id) return false;
        let applied = false;
        setSlots((prev) => {
          const idx = prev.findIndex((s) => s.sessionID === sid);
          if (idx < 0) return prev;
          const slot = prev[idx];
          const msgIdx = slot.messages.findIndex((m) => m.info.id === info.id);
          if (msgIdx < 0) return prev;
          const nextMessages = slot.messages.map((m, i) =>
            i === msgIdx ? { ...m, info } : m,
          );
          const copy = prev.slice();
          copy[idx] = {
            ...slot,
            messages: nextMessages,
            lastUpdated: Date.now(),
          };
          applied = true;
          return copy;
        });
        return applied;
      }
      return false;
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
        // Try to merge the event locally; only refetch if we can't.
        // Local merges are O(1); refetch is O(full history × N bytes)
        // and over parallel worker activity dominates hydration cost.
        if (applyLocally(ev, sid)) return;
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
