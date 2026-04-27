'use client';

// HARDENING_PLAN.md#C10 — live.ts split.
//
// Backend-health observation hooks. useOpencodeHealth polls /project at
// the cheapest possible cadence (single round-trip, light response) and
// shares one TanStack Query cache entry across every caller. useBackendStale
// layers a debounce on top — flips true after two consecutive offline
// readings so a single transient failure doesn't gray out every chip.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getProjectsBrowser } from './_fetchers';

export type HealthStatus = 'live' | 'offline' | 'checking';

export interface HealthSnapshot {
  status: HealthStatus;
  projectCount: number;
  lastChecked: number;
  error?: string;
}

// Lightweight health probe — single request to /project, cheap enough to poll
// every few seconds as a background heartbeat for the prototype's footer.
//
// Migrated to TanStack Query (2026-04-24). Before the migration, each
// call site (page.tsx + two via useBackendStale in topbar/timeline)
// spawned its own poller — 3 independent /project fetches every 5s,
// contributing ~27 calls in a 40s cold load. With TanStack Query,
// all three share one query key and dedup automatically.
export function useOpencodeHealth(intervalMs = 5000): HealthSnapshot {
  const q = useQuery({
    queryKey: OPENCODE_HEALTH_QUERY_KEY,
    queryFn: opencodeHealthFetcher,
    refetchInterval: intervalMs,
    placeholderData: (prev) => prev,
    // On error, don't retry aggressively — the interval will retry anyway.
    retry: false,
  });
  if (q.data) return q.data;
  if (q.error) {
    return {
      status: 'offline',
      projectCount: 0,
      lastChecked: Date.now(),
      error: (q.error as Error).message,
    };
  }
  return { status: 'checking', projectCount: 0, lastChecked: 0 };
}

export const OPENCODE_HEALTH_QUERY_KEY = ['opencode', 'health'] as const;

async function opencodeHealthFetcher(): Promise<HealthSnapshot> {
  const projects = await getProjectsBrowser();
  return {
    status: 'live',
    projectCount: projects.length,
    lastChecked: Date.now(),
  };
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
// HARDENING_PLAN.md#E3 — the bible flagged this as "spawns N independent
// 5s pollers". Audit confirmed that's not actually true: the underlying
// /project poll is already TanStack-deduped via OPENCODE_HEALTH_QUERY_KEY,
// so any number of useOpencodeHealth callers share one refetchInterval
// (per the migration commit's docstring above on useOpencodeHealth). The
// per-caller piece is the offline-streak debounce — useState + useRef +
// useEffect — but at 3 callers × ~50 bytes of React state each, the
// "perf cost" is trivial and the debounce is load-bearing UX (tolerates
// one transient failed probe before turning chips gray). Wrapping in a
// BackendHealthProvider Context would just re-implement what TanStack
// Query already gives us at the network layer. Keeping the per-caller
// debounce is correct.
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
