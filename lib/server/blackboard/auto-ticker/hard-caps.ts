// Stage 2 hard-cap enforcement.
//
// Extracted from auto-ticker.ts in #106 phase 3d. Three dimensions, any
// of which triggers stop:
//   - wall-clock (ms since state.startedAtMs) vs minutesCap
//   - totalCommits vs commitsCap
//   - count of kind='todo' board items vs todosCap
//
// All three default to the ollama-swarm spec's values when meta.bounds
// doesn't override; users who want longer / larger runs set per-run
// caps explicitly. costCap is NOT checked here — the opencode proxy
// gate at app/api/opencode/[...path]/route.ts owns that dimension
// (it 402s the prompt before the model turn spends tokens).

import 'server-only';

import { getRun } from '../../swarm-registry';
import { listBoardItems } from '../store';
import { stopAutoTicker } from './stop';
import type { TickerState } from './types';

// Hard-cap defaults: "fire whichever first — wall-clock 8h, 200
// commits, 300 todos". Effective caps are max(meta.bounds.<cap>,
// default). Per-run override is authoritative when set; defaults keep
// hands-off runs from running forever.
const DEFAULT_WALLCLOCK_MINUTES = 8 * 60; // 8h
const DEFAULT_COMMITS_CAP = 200;
const DEFAULT_TODOS_CAP = 300;

// Hard-cap check — Stage 2. Called after each successful commit and
// before each tick. Returns true if a cap breached; caller stops the
// ticker. Reads meta lazily (caller paths are hot enough that we
// benefit from not forcing a getRun on every tick).
export async function checkHardCaps(state: TickerState): Promise<boolean> {
  if (state.stopped) return false;
  const meta = await getRun(state.swarmRunID).catch(() => null);
  if (!meta) return false;

  const minutesCap = meta.bounds?.minutesCap ?? DEFAULT_WALLCLOCK_MINUTES;
  const commitsCap = meta.bounds?.commitsCap ?? DEFAULT_COMMITS_CAP;
  const todosCap = meta.bounds?.todosCap ?? DEFAULT_TODOS_CAP;

  const elapsedMs = Date.now() - state.startedAtMs;
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes >= minutesCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: wall-clock cap breached — ${Math.round(elapsedMinutes)}min >= ${minutesCap}min. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'wall-clock-cap');
    return true;
  }

  if (state.totalCommits >= commitsCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: commits cap breached — ${state.totalCommits} >= ${commitsCap}. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'commits-cap');
    return true;
  }

  // Todos seen = count of kind='todo' board items (any status). Cheap
  // enough at prototype scale (hundreds of items in-memory).
  const todoCount = listBoardItems(state.swarmRunID).filter(
    (i) => i.kind === 'todo',
  ).length;
  if (todoCount >= todosCap) {
    console.log(
      `[board/auto-ticker] ${state.swarmRunID}: todos cap breached — ${todoCount} >= ${todosCap} authored. Stopping.`,
    );
    stopAutoTicker(state.swarmRunID, 'todos-cap');
    return true;
  }

  return false;
}
