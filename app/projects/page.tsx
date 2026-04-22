'use client';

import { useCallback, useEffect, useState } from 'react';
import { ProjectsMatrix } from '@/components/projects-matrix';
import type { SwarmRunListRow } from '@/lib/swarm-run-types';

// /projects — project-time matrix of every swarm run, grouped by workspace.
//
// Client component so window-size switches (7d / 30d / 90d) and manual
// refresh don't round-trip. Rows come from the existing GET /api/swarm/run
// feed — same source as the run picker and /metrics — which already
// carries lastActivityTs + cost + tokens + status per row. Grouping by
// workspace happens client-side in ProjectsMatrix; at prototype scale
// (tens to a few hundred runs) that's cheap.

export default function ProjectsPage() {
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
    <ProjectsMatrix
      rows={rows ?? []}
      loading={rows === null}
      error={error}
      onRefresh={() => void load()}
      refreshing={refreshing}
    />
  );
}
