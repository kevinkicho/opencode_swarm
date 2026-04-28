'use client';

// Projects modal with internal navigation: matrix view ↔ per-repo
// detail view. Two states inside one modal:
//
//   state 1 (default): the projects matrix (5 repos × N days)
//   state 2 (after click): the repo-runs-view for the selected repo,
//                          with a back button at the top to return
//
// 2026-04-28 — user reported that clicking a repo name in the matrix
// dropped them onto /projects/[slug] which broke the new modal-first
// pattern (took the whole view-space). The /projects/[slug] route
// is preserved for direct linking, but the in-app drill-down stays
// inside this modal.

import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from './ui/modal';
import { ProjectsMatrix } from './projects-matrix';
import { RepoRunsView } from './repo-runs-view';
import { SWARM_RUNS_QUERY_KEY, useSwarmRuns } from '@/lib/opencode/live';

function repoNameOf(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').pop() ?? '';
  return leaf || workspace;
}

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

  // Internal "drill-down" state. null = show matrix; non-null = show
  // RepoRunsView for that repo's slug.
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  // When the modal closes (or is forced closed via the X), reset the
  // drill-down so re-opening starts on the matrix again. Wrap onClose
  // so callers don't need to think about the internal state.
  const handleClose = useCallback(() => {
    setSelectedRepo(null);
    onClose();
  }, [onClose]);

  // Filter rows to the selected repo when drilled in.
  const drillRows = useMemo(() => {
    if (!selectedRepo) return [];
    return rows.filter((r) => repoNameOf(r.meta.workspace) === selectedRepo);
  }, [rows, selectedRepo]);

  if (!open) return null;

  // Title + eyebrow change when drilled in so the user knows where
  // they are. The eyebrow doubles as the back affordance — see the
  // back button rendered inside the body for the actual click target.
  const title = selectedRepo ?? 'projects';
  const eyebrow = selectedRepo ? 'repo · runs' : 'project-time matrix';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      eyebrow={eyebrow}
      title={title}
      width="max-w-[1400px]"
    >
      {selectedRepo ? (
        <div className="flex flex-col min-h-0 max-h-[80vh]">
          <div className="hairline-b px-4 h-7 flex items-center gap-3 bg-ink-900/40 shrink-0">
            <button
              type="button"
              onClick={() => setSelectedRepo(null)}
              className="font-mono text-micro uppercase tracking-widest2 text-fog-500 hover:text-fog-200 transition cursor-pointer"
            >
              ← back to all repos
            </button>
            <span className="font-mono text-micro text-fog-700 tabular-nums">
              {drillRows.length} run{drillRows.length === 1 ? '' : 's'} in this repo
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onRefresh}
              className="h-5 px-2 rounded-sm font-mono text-micro uppercase tracking-widest2 text-fog-500 hover:text-fog-200 hover:bg-ink-800/60 transition cursor-pointer"
            >
              refresh
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {drillRows.length === 0 ? (
              <div className="px-4 py-6 font-mono text-[11px] text-fog-600">
                no runs found for this repo.
              </div>
            ) : (
              <RepoRunsView rows={drillRows} />
            )}
          </div>
        </div>
      ) : (
        <ProjectsMatrix
          rows={rows}
          loading={rows.length === 0 && !error}
          error={error}
          onRefresh={onRefresh}
          refreshing={false}
          embedded
          onSelectRepo={setSelectedRepo}
        />
      )}
    </Modal>
  );
}
