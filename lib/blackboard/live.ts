'use client';

import { useEffect, useState } from 'react';
import type { BoardAgent, BoardItem } from './types';

// Shared polling hook for the blackboard `/board` endpoint. Lives in
// `lib/blackboard/` so both the full board page (`/board-preview`) and the
// inline board rail in the run view (`components/board-rail.tsx`) go through
// one code path. SSE would be the eventual home, but board writes are
// infrequent enough that 2s polling stays honest — see SWARM_PATTERNS.md §1
// status block for where SSE mux sits on the roadmap.

const POLL_INTERVAL_MS = 2000;

export interface LiveBoard {
  items: BoardItem[] | null;
  error: string | null;
}

export function useLiveBoard(swarmRunID: string | null): LiveBoard {
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!swarmRunID) {
      setItems(null);
      setError(null);
      return;
    }
    let cancelled = false;
    async function fetchOnce() {
      try {
        const r = await fetch(`/api/swarm/run/${swarmRunID}/board`, {
          cache: 'no-store',
        });
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError((data as { error?: string }).error ?? `HTTP ${r.status}`);
          setItems(null);
          return;
        }
        setItems((data as { items: BoardItem[] }).items);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    fetchOnce();
    const timer = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [swarmRunID]);

  return { items, error };
}

// Synthesize a BoardAgent from the board's ownerAgentId strings. The live
// store doesn't carry agent metadata (names, glyphs, accents) — those are UI
// sugar — so we derive a deterministic identity per unique owner id. Hashing
// the id for accent keeps the same agent the same color across polls and
// reloads. Falls back gracefully for non-`ag_*` shapes.
const DERIVED_ACCENTS: BoardAgent['accent'][] = ['molten', 'mint', 'iris', 'amber', 'fog'];

export function deriveBoardAgents(items: BoardItem[]): BoardAgent[] {
  const seen = new Set<string>();
  const out: BoardAgent[] = [];
  for (const it of items) {
    const id = it.ownerAgentId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const bare = id.startsWith('ag_') ? id.slice(3) : id;
    const shortName = bare.split('_')[0] || bare;
    let h = 0;
    for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
    out.push({
      id,
      name: shortName,
      accent: DERIVED_ACCENTS[Math.abs(h) % DERIVED_ACCENTS.length],
      glyph: (shortName[0] ?? '?').toUpperCase(),
    });
  }
  return out;
}
