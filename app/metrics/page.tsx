'use client';

import { useCallback, useEffect, useState } from 'react';
import { CrossPresetMetrics } from '@/components/cross-preset-metrics';
import type { SwarmRunListRow } from '@/lib/swarm-run-types';

// /metrics — cross-preset comparison dashboard.
//
// Client component so the "refresh" action is instant and so the window
// date range recomputes without a server round-trip. Rows come from the
// existing GET /api/swarm/run (same feed the run picker uses), which
// already carries cost / tokens / lastActivityTs per row. No new backend
// aggregation at v1 — at prototype scale (tens of runs) the grouping
// happens in CrossPresetMetrics::computePatternStats.

export default function MetricsPage() {
  const [rows, setRows] = useState<SwarmRunListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch('/api/swarm/run', { cache: 'no-store' });
      const data = (await r.json()) as { runs?: SwarmRunListRow[]; error?: string };
      if (!r.ok) {
        setError(data.error ?? `HTTP ${r.status}`);
        return;
      }
      setRows(data.runs ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <CrossPresetMetrics
      rows={rows ?? []}
      loading={rows === null}
      error={error}
      onRefresh={() => void load()}
      refreshing={refreshing}
    />
  );
}
