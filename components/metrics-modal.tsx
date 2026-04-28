'use client';

// Metrics modal — wraps CrossPresetMetrics in a Modal so the cross-
// preset table is reachable without a full-page navigation. Trigger
// from the status-rail "metrics" button.
//
// 2026-04-28: user asked that cost / metrics / projects all open
// as overlays (modal/drawer) rather than as full-page routes. Cost
// already used a Drawer; metrics + projects were `<Link href="/...">`
// navigations. The /metrics route is preserved for direct linking
// + bookmarks; the status-rail button opens this modal instead.

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from './ui/modal';
import { CrossPresetMetrics } from './cross-preset-metrics';
import { SWARM_RUNS_QUERY_KEY, useSwarmRuns } from '@/lib/opencode/live';

export function MetricsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Hard-bail when closed so the polling hook doesn't fire while the
  // modal is dormant (same pattern as DiagnosticsModal).
  const enabled = open;
  const { rows, error } = useSwarmRuns({ intervalMs: 30_000, enabled });
  const queryClient = useQueryClient();
  const onRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: SWARM_RUNS_QUERY_KEY });
  }, [queryClient]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="cross-preset"
      title="metrics"
      width="max-w-[1200px]"
    >
      <CrossPresetMetrics
        rows={rows}
        loading={rows.length === 0 && !error}
        error={error}
        onRefresh={onRefresh}
        refreshing={false}
        embedded
      />
    </Modal>
  );
}
