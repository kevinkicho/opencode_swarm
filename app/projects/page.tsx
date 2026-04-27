'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ProjectsMatrix } from '@/components/projects-matrix';
import { SWARM_RUNS_QUERY_KEY, useSwarmRuns } from '@/lib/opencode/live';

// /projects — project-time matrix of every swarm run, grouped by workspace.
//
// Client component so window-size switches (7d / 30d / 90d) and manual
// refresh don't round-trip. Rows come from the existing GET /api/swarm/run
// feed — same source as the run picker and /metrics — which already
// carries lastActivityTs + cost + tokens + status per row. Grouping by
// workspace happens client-side in ProjectsMatrix; at prototype scale
// (tens to a few hundred runs) that's cheap.
//
// page shares the TanStack queryKey + dedup with the run picker. Pre-fix
// this page did its own raw fetch + useState/useEffect, costing one
// extra cold-load round-trip every time the user navigated here.

export default function ProjectsPage() {
  const { rows, error } = useSwarmRuns({ intervalMs: 30000 });
  const queryClient = useQueryClient();
  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SWARM_RUNS_QUERY_KEY });
  }, [queryClient]);

  return (
    <ProjectsMatrix
      rows={rows}
      loading={rows.length === 0 && !error}
      error={error}
      onRefresh={onRefresh}
      refreshing={false}
    />
  );
}
