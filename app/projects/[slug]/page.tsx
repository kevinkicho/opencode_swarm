'use client';

import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { RepoRunsView } from '@/components/repo-runs-view';
import { SWARM_RUNS_QUERY_KEY, useSwarmRuns } from '@/lib/opencode/live';

// /projects/[slug] — cross-run comparison surface for one workspace.
//
// Answers: "what have I tried on this repo? what worked / what burned
// tokens / how does pattern X compare to pattern Y here?" Same backend
// as /projects (GET /api/swarm/run) — filtered client-side to runs
// whose workspace leaf matches the slug. Multiple workspaces can share
// a leaf name (two repos named `app` in different dirs); we show them
// grouped by full workspace path so the user isn't confused.
//
// Continuation chains: `continuationOf` pointers produce lineages
// visible as a threaded list so "unleash a swarm on this repo for a
// week, bouncing through patterns as needed" is navigable after the
// fact.

function repoNameOf(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').pop() ?? '';
  return leaf || workspace;
}

export default function ProjectDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = decodeURIComponent(params.slug);

  // so this page reuses cached data instead of triggering a separate
  // round trip on every navigation.
  const { rows, error } = useSwarmRuns({ intervalMs: 30000 });
  const queryClient = useQueryClient();
  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SWARM_RUNS_QUERY_KEY });
  }, [queryClient]);

  const matching = useMemo(
    () => rows.filter((row) => repoNameOf(row.meta.workspace) === slug),
    [rows, slug],
  );

  return (
    <div className="flex flex-col h-screen w-screen bg-ink-900 bg-noise">
      <header className="shrink-0 flex items-center justify-between px-4 h-10 hairline-b bg-ink-850/60">
        <div className="flex items-center gap-3">
          <Link
            href="/projects"
            className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-300"
          >
            ← projects
          </Link>
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
            /
          </span>
          <span className="font-mono text-[13px] text-fog-200">{slug}</span>
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700 tabular-nums">
            {matching.length} run{matching.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-micro uppercase tracking-widest2 text-fog-500 hover:text-fog-300"
        >
          refresh
        </button>
      </header>

      {error && (
        <div className="shrink-0 px-4 py-2 hairline-b bg-rust/10 font-mono text-[11px] text-rust">
          {error}
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="flex-1 grid place-items-center font-mono text-micro uppercase tracking-widest2 text-fog-700">
          loading…
        </div>
      ) : matching.length === 0 ? (
        <div className="flex-1 grid place-items-center">
          <div className="font-mono text-[11px] text-fog-600 space-y-1 text-center">
            <div>no runs found for repo &ldquo;{slug}&rdquo;.</div>
            <div className="text-fog-700">the URL slug must match a workspace&apos;s leaf directory name.</div>
          </div>
        </div>
      ) : (
        <RepoRunsView rows={matching} />
      )}
    </div>
  );
}
