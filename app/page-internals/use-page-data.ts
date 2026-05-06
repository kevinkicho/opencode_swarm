'use client';

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLiveBoard, useLiveTicker, roleNamesFromMeta } from '@/lib/blackboard/live';
import {
  useLiveSession,
  useLivePermissions,
  useLiveSwarmRunMessages,
  useSwarmRunSnapshot,
  useSwarmRuns,
} from '@/lib/opencode/live';
import { deriveSilentSessions } from '@/lib/silent-session';
import { useSwarmView } from './use-swarm-view';
import type { SwarmRunMeta, SwarmRunStatus } from '@/lib/swarm-run-types';

export type PageData = ReturnType<typeof usePageData>;

export function usePageData() {
  const params = useSearchParams();
  const swarmRunID = params.get('swarmRun');
  const directSessionId = params.get('session');

  const swarmRunSnap = useSwarmRunSnapshot(swarmRunID);
  const swarmRunMeta_ = swarmRunSnap.snapshot?.meta ?? null;
  const swarmRunNotFound = swarmRunSnap.notFound;
  const swarmRunPrimarySessionID = swarmRunMeta_?.sessionIDs[0] ?? null;

  const runsSnapshot = useSwarmRuns({ intervalMs: 30000, enabled: true });
  const currentRunStatus: SwarmRunStatus | null = useMemo(() => {
    if (!swarmRunID) return null;
    const row = runsSnapshot.rows.find((r) => r.meta.swarmRunID === swarmRunID);
    return row?.status ?? null;
  }, [runsSnapshot.rows, swarmRunID]);

  const swarmRunMissing = Boolean(swarmRunID) && swarmRunNotFound;
  const sessionId = swarmRunMissing
    ? null
    : swarmRunID
      ? swarmRunPrimarySessionID
      : directSessionId;
  const { data: liveData, loading: liveLoading } = useLiveSession(sessionId);
  const liveSwarmRun = useLiveSwarmRunMessages(swarmRunMeta_);

  const snapshotLoading = Boolean(swarmRunID) && !swarmRunSnap.snapshot && !swarmRunNotFound;
  const messagesLoading = Boolean(swarmRunID) && (snapshotLoading || liveLoading || liveSwarmRun.loading);
  const isMultiSession = (swarmRunMeta_?.sessionIDs.length ?? 0) > 1;
  const liveDirectory = liveData?.session?.directory ?? null;
  const permissions = useLivePermissions(sessionId, liveDirectory);

  const view = useSwarmView({
    isMultiSession,
    liveSwarmRun,
    swarmRunMeta: swarmRunMeta_,
    sessionId,
    liveData: liveData ?? null,
  });

  const agents = useMemo(() => {
    if (permissions.pending.length === 0) return view.agents;
    return view.agents.map((a) =>
      a.status === 'working' || a.status === 'thinking'
        ? { ...a, status: 'waiting' as const }
        : a
    );
  }, [view.agents, permissions.pending.length]);

  const boardPatterns: ReadonlySet<string> = useMemo(
    () => new Set<string>(['blackboard', 'orchestrator-worker']),
    [],
  );
  const boardSwarmRunID =
    swarmRunMeta_?.pattern && boardPatterns.has(swarmRunMeta_.pattern)
      ? swarmRunMeta_.swarmRunID
      : null;
  const liveBoard = useLiveBoard(boardSwarmRunID);
  const liveTicker = useLiveTicker(boardSwarmRunID);
  const boardRoleNames = useMemo(
    () => roleNamesFromMeta(swarmRunMeta_),
    [swarmRunMeta_],
  );

  const silentSessions = useMemo(() => {
    if (currentRunStatus !== 'live' && currentRunStatus !== 'idle') return [];
    return deriveSilentSessions(liveSwarmRun.slots);
  }, [liveSwarmRun.slots, currentRunStatus]);

  return {
    swarmRunID,
    directSessionId,
    swarmRunMeta: swarmRunMeta_,
    swarmRunNotFound,
    swarmRunMissing,
    swarmRunStatus: currentRunStatus,
    runsSnapshot,
    sessionId,
    liveData,
    liveSwarmRun,
    messagesLoading,
    isMultiSession,
    liveDirectory,
    permissions,
    view,
    agents,
    boardSwarmRunID,
    liveBoard,
    liveTicker,
    boardRoleNames,
    silentSessions,
  };
}