'use client';

// Cost-cap block + safe-post wrapper hub for the main page (#7.Q26
// decomposition wave 2).
//
// The proxy gate (DESIGN.md §9) throws `CostCapError` whenever a
// session post would push the run past `bounds.costCap`. Pre-extraction,
// PageBody owned a `costCapBlock` useState, a `safePost` useCallback
// wrapping every browser-side post call, plus an effect that cleared
// the block when the active run changed. All three lived inline; every
// component that posted a message had to either use the wrapper or
// repeat the try/catch dance manually.
//
// This hook owns the trio. Consumers call `safePost(...)` instead of
// `postSessionMessageBrowser(...)` directly and read `costCapBlock`
// for the banner. The hook auto-clears the block when `swarmRunID`
// changes — a banner block from a previous run is meaningless for
// the current one.
//
// Returns a stable identity for `safePost` (no deps) so passing it
// down doesn't invalidate downstream memos.

import { useCallback, useEffect, useState } from 'react';
import { postSessionMessageBrowser, CostCapError } from '@/lib/opencode/live';
import { type CostCapBlock } from '@/components/cost-cap-banner';
import type { OpencodeBuiltinAgent } from '@/lib/opencode/types';

export interface SafePostOptions {
  // #7.Q37 — same typed-enum guarantee as postSessionMessageBrowser.
  // A custom role label here would silently 204 the post; the type
  // catches that at compile time.
  agent?: OpencodeBuiltinAgent;
}

export type SafePostResult = { ok: true } | { ok: false; capped: boolean };

export interface CostCapHook {
  costCapBlock: CostCapBlock | null;
  // Wraps postSessionMessageBrowser. On CostCapError → sets the block
  // and returns { ok: false, capped: true }. Other errors → logs and
  // returns { ok: false, capped: false } so multi-session fan-out
  // loops (council, reconcile) can decide whether to bail (capped →
  // yes, abort) or continue (transient → next session).
  safePost: (
    sid: string,
    workspace: string,
    body: string,
    opts: SafePostOptions | undefined,
    context: string,
  ) => Promise<SafePostResult>;
  dismissCap: () => void;
}

export function useCostCapBlock(swarmRunID: string | null): CostCapHook {
  const [costCapBlock, setCostCapBlock] = useState<CostCapBlock | null>(null);

  // Drop any stale block when the active run changes. A block from one
  // run isn't meaningful for another. Also clears when the user exits
  // a swarm-scoped view entirely (swarmRunID → null).
  useEffect(() => {
    setCostCapBlock(null);
  }, [swarmRunID]);

  const safePost = useCallback<CostCapHook['safePost']>(
    async (sid, workspace, body, opts, context) => {
      try {
        await postSessionMessageBrowser(sid, workspace, body, opts);
        return { ok: true };
      } catch (err) {
        if (err instanceof CostCapError) {
          setCostCapBlock({
            swarmRunID: err.swarmRunID,
            costTotal: err.costTotal,
            costCap: err.costCap,
            message: err.message,
          });
          return { ok: false, capped: true };
        }
        console.error(`[${context}] post failed`, sid, err);
        return { ok: false, capped: false };
      }
    },
    [],
  );

  const dismissCap = useCallback(() => {
    setCostCapBlock(null);
  }, []);

  return { costCapBlock, safePost, dismissCap };
}
