// Bulk reopen of stale board items.
//
// POST /api/_debug/swarm-run/:swarmRunID/retry-stale body: {}
//
// retry-stale to /api/_debug/swarm-run/[id]/retry-stale 2026-04-26.
// Operational-recovery endpoint, no UI button (per the original audit
// note that flagged this as orphan). The /api/_debug/* prefix marks
// it as ops-only.
//
// Stale items on the board come from two sources, both semantically dead-ends
// in the normal CAS lifecycle:
// 1. File-drift stale (committed-with-drifted-SHA path) — `staleSinceSha`
// is populated.
// 2. Retry-exhaustion stale (coordinator.retryOrStale fired MAX_STALE_RETRIES
// times, usually because opencode hung or Zen rate-limited the turn)
// — note looks like `[final after 2 retries] turn timed out`, no
// `staleSinceSha`.
// Both are legitimate reasons for the coordinator to stop retrying, but both
// are also the exact shape a user sees after an overnight run that ran into
// rate limits (see memory/reference_opencode_freeze.md). Without a way to
// re-dispatch them, a run with 6/53 stale items stays stuck at 89% forever.
//
// This endpoint flips every stale item back to `open`, clears its owner +
// retry-count note + staleSinceSha, and — if the run is a ticker-driven
// pattern whose ticker is currently stopped — restarts the ticker so the
// coordinator actually picks them up. Without the auto-restart the endpoint
// would look like a no-op from the UI side: items are open but nothing ticks.
//
// Not part of the /board/:itemId route because it's a bulk action across all
// stale items — N single-item calls would be N round-trips for what the user
// experienced as one intent ("retry the stale ones"). Mirrors the existing
// /board/sweep shape (bulk coordinator action colocated under /board).

import type { NextRequest } from 'next/server';

import { getRun } from '@/lib/server/swarm-registry';
import { listBoardItems, transitionStatus } from '@/lib/server/blackboard/store';
import {
 getTickerSnapshot,
 startAutoTicker,
} from '@/lib/server/blackboard/auto-ticker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Patterns whose ticker is responsible for dispatching board work. Extending
// auto-restart to a pattern without a blackboard-style loop would silently
// no-op — better to be explicit so a future `foo-execute` pattern adder knows
// to add itself here. See DESIGN.md §1.5.1.
//
// 2026-04-28 cleanup: dropped `role-differentiated` (cut from the project
// as of 1b7a48d — subsumed by orchestrator-worker; the planner ratchet
// path the role-diff variant added was dead code).
const TICKER_PATTERNS: ReadonlySet<string> = new Set([
 'blackboard',
 'orchestrator-worker',
]);

export async function POST(
 _req: NextRequest,
 { params }: { params: { swarmRunID: string } },
): Promise<Response> {
 const meta = await getRun(params.swarmRunID);
 if (!meta) {
 return Response.json({ error: 'swarm run not found' }, { status: 404 });
 }

 const items = listBoardItems(params.swarmRunID);
 const stale = items.filter((i) => i.status === 'stale');

 const reopened: string[] = [];
 const failed: { id: string; currentStatus: string | null }[] = [];

 for (const item of stale) {
 const result = transitionStatus(params.swarmRunID, item.id, {
 from: 'stale',
 to: 'open',
 ownerAgentId: null,
 fileHashes: null,
 staleSinceSha: null,
 note: null,
 });
 if (result.ok) {
 reopened.push(item.id);
 } else {
 // CAS lost — another request flipped the row between our SELECT and
 // our UPDATE. Not a reason to fail the whole bulk call; record and
 // continue. 404 (currentStatus: null) also folds in here.
 failed.push({ id: item.id, currentStatus: result.currentStatus });
 }
 }

 let tickerRestarted = false;
 if (reopened.length > 0 && TICKER_PATTERNS.has(meta.pattern)) {
 const snap = getTickerSnapshot(params.swarmRunID);
 if (!snap || snap.stopped) {
 // Fresh start clears consecutiveIdle, so the coordinator gets a full
 // budget of poll cycles before the auto-idle stop kicks in. We don't
 // pass periodicSweepMs — this is a retry, not a long-running sweep
 // mode; caller can always POST /board/ticker start for that.
 startAutoTicker(params.swarmRunID, { periodicSweepMs: 0 });
 tickerRestarted = true;
 }
 }

 return Response.json(
 {
 reopened: reopened.length,
 reopenedIds: reopened,
 failed,
 tickerRestarted,
 },
 { status: 200 },
 );
}
