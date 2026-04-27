//
// Pre-extraction, page.tsx mixed three concerns:
//   1. Fetching raw diff text via useSessionDiff(...)
//   2. Parsing it into structured DiffData[] via parseSessionDiffs
//   3. Building a per-file (added, deleted) stats Map keyed by both
//      relative AND absolute paths so the cards view + heat rail
//      lookups resolve regardless of which path shape they hold.
//
// (1) stays at the page level — useSessionDiff is a query hook keyed
// off (sessionId, lastUpdated). (2) and (3) are pure derivations of
// rawDiffs + workspace, so they pull out cleanly into one hook with a
// single dependency array.
//
// Key shape for `byPath`: BOTH the relative path (as the diff ships it)
// and the workspace-prefixed absolute path. Different surfaces carry
// paths in different shapes — heat.path is absolute (came from
// opencode patch.files) while filesTouched in the cards view is also
// absolute. Lookups by either form resolve.
//
// Multi-session caveat: only the primary session's diff is fetched
// today, so stats for files edited exclusively by non-primary sessions
// stay undefined (render as `—`). A future pass can aggregate diffs
// across every sessionID in meta.sessionIDs.

import { useMemo } from 'react';

import { parseSessionDiffs } from '@/lib/opencode/transform';
import type { DiffData } from '@/lib/types';

interface UseDiffStatsArgs {
  rawDiffs: Array<{ file: string; patch: string }> | null;
  workspace: string | undefined;
  liveDirectory: string | null;
}

interface UseDiffStatsResult {
  liveDiffs: DiffData[] | null;
  diffStatsByPath: Map<string, { added: number; deleted: number }>;
}

export function useDiffStats({
  rawDiffs,
  workspace,
  liveDirectory,
}: UseDiffStatsArgs): UseDiffStatsResult {
  const liveDiffs = useMemo<DiffData[] | null>(
    () => (rawDiffs ? parseSessionDiffs(rawDiffs) : null),
    [rawDiffs],
  );
  const diffStatsByPath = useMemo(() => {
    const m = new Map<string, { added: number; deleted: number }>();
    if (!liveDiffs) return m;
    const ws = (workspace ?? liveDirectory ?? '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    for (const d of liveDiffs) {
      const stats = { added: d.additions ?? 0, deleted: d.deletions ?? 0 };
      const rel = d.file.replace(/\\/g, '/').replace(/^\/+/, '');
      m.set(rel, stats);
      if (ws) m.set(`${ws}/${rel}`, stats);
    }
    return m;
  }, [liveDiffs, workspace, liveDirectory]);
  return { liveDiffs, diffStatsByPath };
}
