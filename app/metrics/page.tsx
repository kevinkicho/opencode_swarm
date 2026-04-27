'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CrossPresetMetrics } from '@/components/cross-preset-metrics';
import { SWARM_RUNS_QUERY_KEY, useSwarmRuns } from '@/lib/opencode/live';

// /metrics — cross-preset comparison dashboard.
//
// Client component so the "refresh" action is instant and so the window
// date range recomputes without a server round-trip. Rows come from the
// existing GET /api/swarm/run (same feed the run picker uses), which
// already carries cost / tokens / lastActivityTs per row. No new backend
// aggregation at v1 — at prototype scale (tens of runs) the grouping
// happens in CrossPresetMetrics::computePatternStats.
//
// page shares the TanStack queryKey + dedup with the picker. Pre-fix
// it did its own raw fetch + useState/useEffect, costing one extra
// cold-load round trip.

export default function MetricsPage() {
  const { rows, error } = useSwarmRuns({ intervalMs: 30000 });
  const queryClient = useQueryClient();
  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SWARM_RUNS_QUERY_KEY });
  }, [queryClient]);

  return (
    <CrossPresetMetrics
      rows={rows}
      loading={rows.length === 0 && !error}
      error={error}
      onRefresh={onRefresh}
      refreshing={false}
    />
  );
}
