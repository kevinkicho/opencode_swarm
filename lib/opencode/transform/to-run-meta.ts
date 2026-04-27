//
// Run-level metadata projection — title, status, started/elapsed, cost,
// tokens, cwd. Drives the topbar chips + run-status indicator. Everything
// else (per-message rendering, per-agent rollups) lives elsewhere.

import type { RunMeta } from '../../swarm-types';
import type { OpencodeMessage, OpencodeSession } from '../types';
import { derivedCost } from './_shared';

export function toRunMeta(
  session: OpencodeSession | null,
  messages: OpencodeMessage[],
): RunMeta {
  let totalTokens = 0;
  let totalCost = 0;
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    totalTokens += m.info.tokens?.total ?? 0;
    // Use derivedCost so Zen bundle models (big-pickle) show a pricing-
    // estimated dollar figure instead of $0.00. Aligns with the cost-
    // dashboard's fallback path and makes the topbar honest about
    // non-trivial bundle runs.
    totalCost += derivedCost(m.info);
  }

  const startedMs = session?.time.created ?? messages[0]?.info.time.created ?? Date.now();
  const lastMs =
    messages[messages.length - 1]?.info.time.completed ??
    messages[messages.length - 1]?.info.time.created ??
    Date.now();
  const elapsedSec = Math.max(0, Math.floor((lastMs - startedMs) / 1000));
  const elapsed =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : elapsedSec < 3600
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  // "active" when either (a) the last message is a user message — prompt is
  // committed but opencode hasn't attached the assistant message yet, or
  // (b) the last assistant message has no completed timestamp, no error, and
  // was created within ZOMBIE_THRESHOLD_MS. Missing completed + error set
  // means the turn aborted; missing completed + missing error + old means the
  // opencode process died mid-turn. Without the staleness guard, such zombie
  // sessions render "active" with an abort button forever.
  const ZOMBIE_THRESHOLD_MS = 10 * 60 * 1000;
  const lastMessage = messages[messages.length - 1];
  const lastInfo = lastMessage?.info;
  const isRunning =
    !!lastInfo &&
    (lastInfo.role === 'user' ||
      (!lastInfo.time.completed &&
        !lastInfo.error &&
        Date.now() - lastInfo.time.created < ZOMBIE_THRESHOLD_MS));

  return {
    id: session?.id ?? 'run_live',
    title: session?.title ?? 'live session',
    status: isRunning ? 'active' : 'done',
    started: new Date(startedMs).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    elapsed,
    totalTokens,
    totalCost,
    budgetCap: 5.0,
    cwd: session?.directory ?? '',
  };
}
