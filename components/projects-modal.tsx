'use client';

// Projects modal — wraps ProjectsMatrix in a Modal so the project-
// time matrix is reachable without a full-page navigation. Trigger
// from the status-rail "projects" button.
//
// 2026-04-28: see metrics-modal.tsx for the user-driven motivation.
// /projects route is preserved for direct linking + bookmarks; the
// status-rail button opens this modal instead.

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from './ui/modal';
import { ProjectsMatrix } from './projects-matrix';
import { SWARM_RUNS_QUERY_KEY, useSwarmRuns } from '@/lib/opencode/live';

export function ProjectsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
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
      eyebrow="project-time matrix"
      title="projects"
      width="max-w-[1400px]"
    >
      <ProjectsMatrix
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
