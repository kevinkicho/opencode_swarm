// Pure data extraction for the MapRail.
//
// Lifted from map-rail.tsx 2026-04-28. No React, no DOM — derives
// the scope annotation, status, file-touch count, output-line count,
// and assistant token total from a LiveSwarmSessionSlot.

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import { countLines, turnText } from '../rails/_shared';

export interface MapRow {
  slotIndex: number;
  sessionID: string;
  scope: string; // truncated; full in title
  scopeFull: string;
  status: 'pending' | 'working' | 'idle' | 'errored';
  outputLines: number;
  filesTouched: number;
  tokens: number;
}

export interface ReduceRow {
  itemID: string;
  status: 'awaiting' | 'claimed' | 'running' | 'done' | 'stale';
  ownerSlot: number | null;
  elapsedMinutes: number | null;
  outputLines: number;
}

// Extract the scope annotation from the first user message. Convention
// from buildScopedDirective (lib/server/map-reduce.ts:98-114): the
// kickoff prompt mentions "your scope:" or similar followed by paths.
// Fall back to a generic "scope?" placeholder if we can't find it.
export function extractScope(slot: LiveSwarmSessionSlot): string {
  const firstUser = slot.messages.find((m) => m.info.role === 'user');
  if (!firstUser) return '';
  const text = turnText(firstUser);
  // Look for "scope:" / "Your scope:" / "Slice:" prefixes (lenient).
  const m = /(?:scope|slice)\s*:?\s*([^.\n]+)/i.exec(text);
  if (m) return m[1].trim().slice(0, 80);
  return '';
}

// Count files touched in a session via patch parts. We skip the read-
// only file-watcher signal and only count parts whose type === 'patch'.
export function countFilesTouched(slot: LiveSwarmSessionSlot): number {
  const seen = new Set<string>();
  for (const m of slot.messages) {
    for (const p of m.parts) {
      if (p.type === 'patch') {
        // patch parts have a `files` array (per opencode types).
        const files = (p as { files?: string[] }).files ?? [];
        for (const f of files) seen.add(f);
      }
    }
  }
  return seen.size;
}

export function sessionTokens(slot: LiveSwarmSessionSlot): number {
  let n = 0;
  for (const m of slot.messages) {
    if (m.info.role !== 'assistant') continue;
    n += m.info.tokens?.total ?? 0;
  }
  return n;
}

export function sessionStatus(slot: LiveSwarmSessionSlot): MapRow['status'] {
  if (slot.messages.length === 0) return 'pending';
  const lastAssist = [...slot.messages]
    .reverse()
    .find((m) => m.info.role === 'assistant');
  if (!lastAssist) return 'pending';
  if (lastAssist.info.error) return 'errored';
  if (lastAssist.info.time.completed) return 'idle';
  return 'working';
}

export function sessionOutputLines(slot: LiveSwarmSessionSlot): number {
  // Sum text-part lines across all assistant messages — proxy for
  // "how much did this session generate" without holding the full text
  // in memory.
  let n = 0;
  for (const m of slot.messages) {
    if (m.info.role !== 'assistant') continue;
    n += countLines(turnText(m));
  }
  return n;
}
