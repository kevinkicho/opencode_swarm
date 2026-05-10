//
// Live-derivation layer for swarm runs. Computes per-session and per-run
// status / tokens / cost by probing opencode's session-message endpoint,
// then folds the per-session results into a run-level row that the picker
// + topbar consume.
//
// This file deliberately has no filesystem dependencies — it takes a
// SwarmRunMeta as input (loaded by callers via fs.ts's getRun/listRuns)
// and returns DerivedRow / RunTokensBreakdown. The persistence layer
// lives in `./fs.ts`; the barrel `lib/server/swarm-registry.ts` re-exports
// both halves for backward-compat with callers.
//
// This module is server-only — do not import from 'use client' code.

import 'server-only';

// dynamic-imported inside deriveSessionRow rather than static-imported
// here. Static import pulls the full opencode-server graph (~1100
// modules) into every route that imports swarm-registry, even routes
// that only need getRun/listRuns. Dynamic import lets Next.js split
// the heavy chain off the cold-compile path. Same pattern Q46 used
// for the ticker route. Type-only import keeps the symbol available
// for the deriveSessionRow signature without dragging the runtime.
import type { getSessionMessagesServer as GetSessionMessagesServerFn } from '../opencode-server';
import { LRU } from '../lru';
import { priceFor } from '../../opencode/pricing';
import type {
  OpencodeMessage,
  OpencodeMessageInfo,
  OpencodePart,
} from '../../opencode/types';
import type {
  SwarmRunMeta,
  SwarmRunStatus,
} from '../../swarm-run-types';

// A turn with no `completed` timestamp that's older than this is treated as
// a zombie: opencode probably crashed mid-turn or the process was killed
// before the assistant could finish. Mirrors the threshold in
// transform.ts's liveness heuristic so the single-session and cross-run
// views agree on what "running" means. See memory note
// "opencode zombie assistant messages" for why this guard exists.
const ZOMBIE_THRESHOLD_MS = 10 * 60 * 1000;

// Cost fallback for assistant messages where opencode didn't populate
// `info.cost` (free tiers, old sessions, go-bundle messages). Mirrors
// `derivedCost` in transform.ts so single-run and cross-run dollar figures
// match within rounding. Duplicated here rather than imported because
// transform.ts is a client-adjacent module and we want the server path
// free of its transitive deps.
//
// For ollama and other providers that don't report per-message token counts,
// we estimate from part content length (~4 chars per token) and use the
// model's pricing tier. This gives a reasonable approximation for cost
// and token dashboards rather than showing $0.00 / 0 tokens forever.
const CHARS_PER_TOKEN = 4;

function estimateTokensFromParts(parts: OpencodePart[]): number {
  let chars = 0;
  for (const p of parts) {
    if (p.type === 'text' || p.type === 'reasoning') {
      chars += (p as { text: string }).text.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function costForAssistant(info: OpencodeMessageInfo, parts: OpencodePart[]): number {
  // When opencode provides a positive cost, trust it and return directly.
  // When cost is 0 (ollama flat-rate plans that don't bill per-token),
  // fall through to compute from tokens or estimate — $0 is a pricing tier
  // signal, not "no data."
  if (typeof info.cost === 'number' && info.cost > 0) return info.cost;
  const price = priceFor(info.modelID, info.providerID);
  const t = info.tokens;
  // If opencode reported real token counts, use them directly.
  if (t && t.total > 0) {
    if (!price) return 0;
    const input = t.input * price.input;
    const output = t.output * price.output;
    const cachedRead = t.cache.read * price.cached;
    const cachedWrite = t.cache.write * (price.write ?? price.input);
    return (input + output + cachedRead + cachedWrite) / 1_000_000;
  }
  // Zero-token provider (ollama): estimate from part content and apply
  // the model's pricing. If we can't find a price, return 0 rather than NaN.
  if (!price) return 0;
  const estimated = estimateTokensFromParts(parts);
  if (estimated === 0) return 0;
  // Rough 50/50 input/output split — we don't know the real ratio for
  // estimated tokens, but averaging the two rates gives a fair cost.
  const avgRate = (price.input + price.output) / 2;
  return (estimated * avgRate) / 1_000_000;
}

function sumRunMetrics(messages: OpencodeMessage[]): {
  costTotal: number;
  tokensTotal: number;
} {
  let costTotal = 0;
  let tokensTotal = 0;
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    const reported = m.info.tokens?.total ?? 0;
    // Use reported tokens if available, otherwise estimate from content.
    const effectiveTokens = reported > 0 ? reported : estimateTokensFromParts(m.parts);
    tokensTotal += effectiveTokens;
    costTotal += costForAssistant(m.info, m.parts);
  }
  return { costTotal, tokensTotal };
}

export interface DerivedRow {
  status: SwarmRunStatus;
  lastActivityTs: number | null;
  costTotal: number;
  tokensTotal: number;
  messageCount: number;
}

// Classify one session's tail + sum its assistant-message $/tokens. The
// aggregate in deriveRunRow() composes these per-session rows; keeping the
// single-session shape isolated means pattern='none' and pattern='council'
// use the exact same classifier — no divergence to drift.
//
// Never throws. A probe failure collapses to `unknown` + zeros so the
// aggregate can still fold this session in without rejecting the whole run.
// Lazy-load opencode-server on first call. The dynamic import returns
// the same module object on every call (Next.js / Node's import cache
// memoizes), so the cost is paid once per process — and only when a
// route actually fans into deriveRunRow / deriveRunTokens. Routes that
// only need getRun/listRuns skip the entire opencode chain.
let _getSessionMessagesImpl: typeof GetSessionMessagesServerFn | null = null;
async function getSessionMessagesLazy(
  sessionID: string,
  workspace: string,
  signal?: AbortSignal,
) {
  if (!_getSessionMessagesImpl) {
    const mod = await import('../opencode-server');
    _getSessionMessagesImpl = mod.getSessionMessagesServer;
  }
  return _getSessionMessagesImpl(sessionID, workspace, signal);
}

async function deriveSessionRow(
  sessionID: string,
  workspace: string,
  signal?: AbortSignal
): Promise<DerivedRow> {
  let messages;
  try {
    messages = await getSessionMessagesLazy(sessionID, workspace, signal);
  } catch {
    // Could be the session was deleted out from under us, or opencode is
    // momentarily unreachable. Either way, not actionable by the picker —
    // surface as unknown and let the next poll try again.
    return { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0, messageCount: 0 };
  }

  if (messages.length === 0) {
    // Session exists but no messages yet. Usually means the run was just
    // created and the first directive is still in flight. Not idle, not
    // error — honest answer is unknown.
    return { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0, messageCount: 0 };
  }

  const { costTotal, tokensTotal } = sumRunMetrics(messages);
  const assistantMessageCount = messages.filter((m) => m.info.role === 'assistant').length;
  const last = messages[messages.length - 1];
  const info = last.info;
  const now = Date.now();

  // A trailing user message means opencode has accepted a prompt but hasn't
  // yet attached the assistant reply. That's live — but ONLY if the user
  // post is recent. Sessions where the assistant never replied (opencode
  // crashed, the run was aborted before the turn completed, etc.) get
  // stuck with a trailing user message forever; without the freshness
  // check below those orphans claim live status indefinitely. Same
  // threshold the assistant-message zombie path uses below; consistent
  // semantics across the two no-completed-yet branches.
  if (info.role === 'user') {
    if (now - info.time.created < ZOMBIE_THRESHOLD_MS) {
      return { status: 'live', lastActivityTs: info.time.created, costTotal, tokensTotal, messageCount: assistantMessageCount };
    }
    return { status: 'stale', lastActivityTs: info.time.created, costTotal, tokensTotal, messageCount: assistantMessageCount };
  }

  // Assistant message path.
  if (info.error) {
    const errName = (info.error as { name?: string } | null | undefined)?.name;
    if (errName === 'MessageAbortedError') {
      return {
        status: 'stale',
        lastActivityTs: info.time.completed ?? info.time.created,
        costTotal,
        tokensTotal,
        messageCount: assistantMessageCount,
      };
    }
    return {
      status: 'error',
      lastActivityTs: info.time.completed ?? info.time.created,
      costTotal,
      tokensTotal,
      messageCount: assistantMessageCount,
    };
  }
  if (info.time.completed) {
    return { status: 'idle', lastActivityTs: info.time.completed, costTotal, tokensTotal, messageCount: assistantMessageCount };
  }
  // No completed, no error — either actively producing or zombie.
  if (now - info.time.created < ZOMBIE_THRESHOLD_MS) {
    return { status: 'live', lastActivityTs: info.time.created, costTotal, tokensTotal, messageCount: assistantMessageCount };
  }
  return { status: 'stale', lastActivityTs: info.time.created, costTotal, tokensTotal, messageCount: assistantMessageCount };
}

// Priority for folding N per-session statuses into one pre-ticker run-level
// status. The fold answers "what does this run most need my attention for"
// without losing information; ticker reconciliation (in deriveRunRow) then
// applies the alive/stopped axis on top.
//
//   error  → at least one session reported a real failure (highest)
//   live   → at least one session is currently producing tokens
//   idle   → at least one session is between turns (waiting)
//   completed → all sessions finished cleanly, no ticker or ticker stopped cleanly
//   stale  → at least one session is a zombie / cleanly aborted
//   unknown → no probe data
//
// Higher number wins. Any session at a given level pins the fold there.
// Ordering changed from old schema (live > error > stale > idle) so error
// dominates everything — a single failed session is the most actionable
// signal regardless of what its peers are doing.
const STATUS_PRIORITY: Record<SwarmRunStatus, number> = {
  error: 5,
  live: 4,
  idle: 3,
  completed: 2,
  stale: 1,
  unknown: 0,
};

// Row-level derivation: one message fetch per *session*, fanned out in
// parallel across meta.sessionIDs, then folded into one row for the picker:
//   - costTotal / tokensTotal  — sum across all sessions
//   - lastActivityTs           — max across sessions (most recent thing seen)
//   - status                   — priority-reduced via STATUS_PRIORITY
//
// Single-session runs (pattern='none') degenerate to the old behavior: one
// fetch, one classification, no aggregation math to speak of. Multi-session
// runs (pattern='council') fold every member's state in without branching —
// same code path, same cache entry, same error-tolerance semantics.
//
// Never throws. Per-session probe failures already collapse to unknown +
// zeros in deriveSessionRow, so Promise.allSettled is defense-in-depth
// rather than load-bearing — but we keep it so a thrown-from-helper bug
// can't take down an entire list fetch.
export async function deriveRunRow(
  meta: SwarmRunMeta,
  signal?: AbortSignal
): Promise<DerivedRow> {
  if (meta.sessionIDs.length === 0) {
    return { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0, messageCount: 0 };
  }

  const settled = await Promise.allSettled(
    meta.sessionIDs.map((sid) => deriveSessionRow(sid, meta.workspace, signal))
  );

  let costTotal = 0;
  let tokensTotal = 0;
  let messageCount = 0;
  let lastActivityTs: number | null = null;
  let statusRank = STATUS_PRIORITY.unknown;
  let status: SwarmRunStatus = 'unknown';

  for (const r of settled) {
    const row: DerivedRow =
      r.status === 'fulfilled'
        ? r.value
        : { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0, messageCount: 0 };

    costTotal += row.costTotal;
    tokensTotal += row.tokensTotal;
    messageCount += row.messageCount;
    if (row.lastActivityTs !== null) {
      lastActivityTs =
        lastActivityTs === null ? row.lastActivityTs : Math.max(lastActivityTs, row.lastActivityTs);
    }
    const rank = STATUS_PRIORITY[row.status];
    if (rank > statusRank) {
      statusRank = rank;
      status = row.status;
    }
  }

  status = await reconcileWithTicker(meta.swarmRunID, status);
  return { status, lastActivityTs, costTotal, tokensTotal, messageCount };
}

// Apply the alive/stopped axis from the auto-ticker on top of a session-
// fold status. The ticker is authoritative on liveness — sessions only see
// their own tail and can't tell "between dispatches" from "done forever".
//
//   ticker.stopped:
//     - reason in failure-set (opencode-frozen / zen-rate-limit /
//       replan-loop-exhausted) → 'error'  (#7.Q35)
//     - any session reported a real error → 'error'
//     - else → 'stale' (cleanly stopped: cap-stop, manual stop, normal
//       completion, MessageAbortedError everywhere)
//   ticker not stopped:
//     - 'error' from session fold survives (live-with-issue)
//     - 'live' from session fold survives (actively producing)
//     - else (idle/stale/unknown) → 'idle' (alive but quiet — between
//       dispatches, planner waiting; was previously force-promoted to
//       'live' by the old Q28 logic, which hid the quiet state)
//   no ticker info available:
//     - keep error / live as-is
//     - idle from session fold → 'stale' (no ticker = run is over;
//       a completed-cleanly trail without a ticker reads as 'done',
//       not 'alive-and-quiet')
//
// Dynamic import keeps swarm-registry decoupled from the ticker
// module's globalThis registry.
async function reconcileWithTicker(
  swarmRunID: string,
  sessionFoldStatus: SwarmRunStatus,
): Promise<SwarmRunStatus> {
  let tickerSeen = false;
  let tickerRunning = false;
  let tickerFailureStop = false;
  try {
    // Read-only path: import directly from auto-ticker/state instead
    // of the heavy auto-ticker index. The index transitively pulls
    // tick.ts → coordinator → planner — ~1100 unnecessary modules
    // that Next.js dev compiles into every snapshot/runs-list call.
    // Same fix shape as the snapshot/retro routes.
    const { getTickerSnapshot } = await import('../blackboard/auto-ticker/state');
    const ticker = getTickerSnapshot(swarmRunID);
    if (ticker) {
      tickerSeen = true;
      tickerRunning = !ticker.stopped;
    tickerFailureStop =
      ticker.stopped &&
      (ticker.stopReason === 'opencode-frozen' ||
        ticker.stopReason === 'zen-rate-limit' ||
        ticker.stopReason === 'replan-loop-exhausted' ||
        ticker.stopReason === 'filtered-all-todos' ||
        ticker.stopReason === 'stuck-deliberation');

    }
  } catch {
    // ticker registry unreachable — fall through to no-ticker case below.
  }

  let status = sessionFoldStatus;

  if (tickerSeen) {
    if (tickerRunning) {
      if (status !== 'error' && status !== 'live') {
        status = 'idle';
      }
    } else {
      if (tickerFailureStop) {
        status = 'error';
      } else if (status === 'idle') {
        // Ticker stopped cleanly and all sessions idle — the run
        // finished its work under coordinator management.
        status = 'completed';
      } else if (status !== 'error') {
        status = 'stale';
      }
    }
  } else {
    // Runs without a ticker (pattern='none', single-session) can't be
    // "alive but quiet" — there's no coordinator to dispatch new turns.
    // A session-fold status of 'idle' (all sessions completed cleanly)
    // is best described as 'completed' — the run finished its work and
    // won't produce more. Anything else (live/unknown/stale/error) keeps
    // its session-fold status as-is.
    if (status === 'idle') {
      status = 'completed';
    }
  }

  return status;
}

// Per-session token/cost rows + the aggregate, in one fan-out. Separate from
// deriveRunRow because callers that want the granular breakdown (the /tokens
// endpoint, cost-dashboard drill-down) shouldn't have to re-fetch per-session
// data the aggregate already paid for.
//
// Keeps deriveRunRow unchanged — that one's on the hot path (list endpoint,
// 4s poll) and shouldn't pay the extra allocation for callers that only want
// the aggregate. Duplication is ~15 lines; composing via refactor would mean
// touching the cache path for a 1-caller feature.
export interface RunTokensBreakdown {
  totals: {
    tokens: number;
    cost: number;
    lastActivityTs: number | null;
    status: SwarmRunStatus;
  };
  sessions: Array<{
    sessionID: string;
    tokens: number;
    cost: number;
    lastActivityTs: number | null;
    status: SwarmRunStatus;
  }>;
}

export async function deriveRunTokens(
  meta: SwarmRunMeta,
  signal?: AbortSignal,
): Promise<RunTokensBreakdown> {
  if (meta.sessionIDs.length === 0) {
    return {
      totals: { tokens: 0, cost: 0, lastActivityTs: null, status: 'unknown' },
      sessions: [],
    };
  }

  const settled = await Promise.allSettled(
    meta.sessionIDs.map((sid) => deriveSessionRow(sid, meta.workspace, signal)),
  );

  const sessions: RunTokensBreakdown['sessions'] = [];
  let costTotal = 0;
  let tokensTotal = 0;
  let lastActivityTs: number | null = null;
  let statusRank = STATUS_PRIORITY.unknown;
  let status: SwarmRunStatus = 'unknown';

  meta.sessionIDs.forEach((sid, i) => {
    const r = settled[i];
    const row: DerivedRow =
      r.status === 'fulfilled'
        ? r.value
        : { status: 'unknown', lastActivityTs: null, costTotal: 0, tokensTotal: 0, messageCount: 0 };

    sessions.push({
      sessionID: sid,
      tokens: row.tokensTotal,
      cost: row.costTotal,
      lastActivityTs: row.lastActivityTs,
      status: row.status,
    });

    costTotal += row.costTotal;
    tokensTotal += row.tokensTotal;
    if (row.lastActivityTs !== null) {
      lastActivityTs =
        lastActivityTs === null
          ? row.lastActivityTs
          : Math.max(lastActivityTs, row.lastActivityTs);
    }
    const rank = STATUS_PRIORITY[row.status];
    if (rank > statusRank) {
      statusRank = rank;
      status = row.status;
    }
  });

  // Reconcile the totals.status against the ticker so the breakdown
  // and the picker show the same alive/stopped axis. Per-session statuses
  // in `sessions` stay raw — callers visualizing the dashboard want the
  // pre-reconciliation truth (idle = "this session has completed its turn"
  // is meaningful at the per-session row even when the run is still live).
  const reconciledStatus = await reconcileWithTicker(meta.swarmRunID, status);

  return {
    totals: { tokens: tokensTotal, cost: costTotal, lastActivityTs, status: reconciledStatus },
    sessions,
  };
}

// ---- derived-row cache ----------------------------------------------------
//
// deriveRunRow() costs one opencode /message fetch per run. The list
// endpoint fans that out for *every* run on every GET, and the picker polls
// on ~30s cadence (with SSE-driven invalidation for real-time updates), so
// unchanged runs take the same hit they took a moment ago. Short-TTL
// memoization flattens that curve:
//
//   - key:    swarmRunID
//   - value:  { row, fetchedAt } — the full deriveRunRow() return
//   - TTL:    status-aware (30s active, 10min terminal) — see TTL_BY_STATUS
//   - purge:  appendEvent() (in fs.ts) drops the entry for that run, so any
//             new event the multiplexer writes forces the next poll to re-
//             fetch
//
// Shape is survive-restart safe because it lives in process memory only —
// a reboot is a natural purge. `globalThis` pinning matches memoryDb() so
// Next.js's module-reload in dev doesn't duplicate the map.
//
// Not thread-aware: single Next.js worker in dev. If we ever scale to
// multiple workers, this becomes a per-worker cache and runs with stale
// entries across workers — fine for a status picker, but call it out here.
interface CachedRow {
  row: DerivedRow;
  fetchedAt: number;
}

// Status-aware TTL — 2026-04-28, revised 2026-05-07.
//
// Pre-fix: a single 10s TTL across every status. With 146 runs × ~3
// sessions = ~470 opencode probes per cold poll (~5s on WSL2), and
// the picker polling every 4s, every cycle missed cache and the
// route handler was busy 100% of the time. Measured: t=0 cold 5s,
// t=4s another 5s, etc.
//
// Post-fix: terminal statuses (stale, error) cache for 10 minutes
// because they're ONLY revivable via an explicit appendEvent — and
// appendEvent already invalidates the cache (see fs.ts:335). The TTL
// for terminals is just defense against a missed-event regression;
// in steady state, terminal rows derive once and stay derived.
//
// Active statuses (live, idle, unknown) now cache for 30s, matching
// the client-side staleTime. With SSE ticker ticks now driving
// invalidation of SWARM_RUNS_QUERY_KEY on the client, the 30s TTL
// only fires when SSE is disconnected — exactly the safety-net case
// where the data might be up to 30s stale, which is acceptable.
type SwarmStatusKey = SwarmRunStatus;
const TTL_BY_STATUS: Record<SwarmStatusKey, number> = {
  live: 30_000,
  idle: 30_000,
  completed: 600_000,
  unknown: 30_000,
  stale: 600_000,
  error: 600_000,
};

// dev a deleted run's CachedRow never expired. 500 is the same bound
// as metaCache (paired keying — both keyed on swarmRunID).
const DERIVED_CACHE_MAX = 500;
const globalCacheKey = Symbol.for('opencode_swarm.deriveRowCache');
type GlobalWithCache = typeof globalThis & {
  [globalCacheKey]?: LRU<string, CachedRow>;
};
function derivedRowCache(): LRU<string, CachedRow> {
  const g = globalThis as GlobalWithCache;
  if (!g[globalCacheKey]) g[globalCacheKey] = new LRU(DERIVED_CACHE_MAX);
  return g[globalCacheKey]!;
}

// Cached variant of deriveRunRow. Prefer this in the list endpoint; call
// the uncached deriveRunRow directly when freshness matters more than
// latency (e.g. a user clicking "refresh now" on a single run detail).
export async function deriveRunRowCached(
  meta: SwarmRunMeta,
  signal?: AbortSignal
): Promise<DerivedRow> {
  const cache = derivedRowCache();
  const now = Date.now();
  const hit = cache.get(meta.swarmRunID);
  // TTL is per-cached-status: the entry's age is compared against the
  // TTL keyed by that entry's status, not a global. Lets terminal rows
  // (stale/error) live 10 min while active rows churn at 10s.
  if (hit) {
    const ttl = TTL_BY_STATUS[hit.row.status] ?? 10_000;
    if (now - hit.fetchedAt < ttl) return hit.row;
  }
  const row = await deriveRunRow(meta, signal);
  cache.set(meta.swarmRunID, { row, fetchedAt: now });
  return row;
}

// Drop the cached row for one run. Called by fs.ts's appendEvent so
// any new event re-probes opencode on the next poll. Public because of
// the cross-half import — fs.ts depends on this; derive.ts never
// depends on fs.ts.
export function invalidateDerivedRow(swarmRunID: string): void {
  derivedRowCache().delete(swarmRunID);
}
