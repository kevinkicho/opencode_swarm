'use client';

// Browser-side opencode client. Talks to our Next.js proxy at `/api/opencode/*`
// — the proxy injects Basic auth server-side, so no credentials ship here.
//
// lib/opencode/live/ on 2026-04-26. This file is now a re-export barrel
// so the 16+ import sites don't churn. Per-file responsibilities:
//
//   - live/_fetchers.ts              — HTTP fetchers + queryKey helpers +
//                                      CostCapError class
//   - live/use-health.ts             — useOpencodeHealth + useBackendStale
//   - live/use-session.ts            — useLiveSession + useSessionDiff +
//                                      useLiveSessions
//   - live/use-permissions.ts        — useLivePermissions + LivePermissions
//   - live/use-swarm-run-messages.ts — useLiveSwarmRun +
//                                      useLiveSwarmRunMessages (the heavy
//                                      multi-session orchestrator)
//   - live/use-swarm-runs.ts         — useSwarmRuns + useSwarmRunSnapshot +
//                                      useSwarmRunEvents

export {
  CostCapError,
  abortSessionBrowser,
  createSessionBrowser,
  getAllSessionsBrowser,
  getPendingPermissionsBrowser,
  getProjectsBrowser,
  getSessionBrowser,
  getSessionDiffBrowser,
  getSessionMessagesBrowser,
  getSessionsByDirectoryBrowser,
  postSessionMessageBrowser,
  replyPermissionBrowser,
  sessionDiffQueryKey,
  sessionMessagesQueryKey,
} from './live/_fetchers';

export {
  OPENCODE_HEALTH_QUERY_KEY,
  useBackendStale,
  useOpencodeHealth,
  type HealthSnapshot,
  type HealthStatus,
} from './live/use-health';

export {
  LIVE_SESSIONS_QUERY_KEY,
  useLiveSession,
  useLiveSessions,
  useSessionDiff,
  type LiveSessionSnapshot,
  type LiveSnapshot,
} from './live/use-session';

export {
  useLivePermissions,
  type LivePermissions,
} from './live/use-permissions';

export {
  useLiveSwarmRun,
  useLiveSwarmRunMessages,
  type LiveSwarmRunMessagesSnapshot,
  type LiveSwarmRunSnapshot,
  type LiveSwarmSessionSlot,
} from './live/use-swarm-run-messages';

export {
  SWARM_RUNS_QUERY_KEY,
  SWARM_RUN_SNAPSHOT_QUERY_KEY,
  useSwarmRunEvents,
  useSwarmRunSnapshot,
  useSwarmRuns,
  type SwarmRunEventRow,
  type SwarmRunEventsSnapshot,
  type SwarmRunPhase,
  type SwarmRunSnapshot,
  type SwarmRunSnapshotResult,
  type SwarmRunsSnapshot,
} from './live/use-swarm-runs';

export {
  OPENCODE_PROVIDERS_QUERY_KEY,
  useOpencodeProviders,
  type UseOpencodeProvidersResult,
} from './live/use-opencode-providers';
