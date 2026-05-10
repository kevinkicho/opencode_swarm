'use client';

import { useQuery } from '@tanstack/react-query';
import { Modal } from './ui/modal';

interface AgentRetro {
  sessionID: string;
  name: string;
  todosCompleted: number;
  todosStale: number;
  filesEdited: string[];
}

interface RunRetro {
  swarmRunID: string;
  pattern: string;
  costTotal: number;
  tokensTotal: number;
  todosCompleted: number;
  todosStale: number;
  criteriaMet: number;
  criteriaUnmet: number;
  agents: AgentRetro[];
}

export function RunRetroModal({
  open,
  onClose,
  swarmRunID,
}: {
  open: boolean;
  onClose: () => void;
  swarmRunID: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['retro', swarmRunID],
    queryFn: async ({ signal }): Promise<RunRetro> => {
      const res = await fetch(
        `/api/swarm/run/${encodeURIComponent(swarmRunID)}/retro`,
        { cache: 'no-store', signal },
      );
      if (!res.ok) {
        throw new Error(`retro fetch failed (${res.status})`);
      }
      return res.json() as Promise<RunRetro>;
    },
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });

  const totalDone = (data?.todosCompleted ?? 0) + (data?.todosStale ?? 0);
  const completionRate =
    totalDone > 0
      ? `${Math.round(((data?.todosCompleted ?? 0) / totalDone) * 100)}%`
      : '—';

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="review"
      title="run retro"
      width="max-w-2xl"
    >
      {isLoading && (
        <div className="font-mono text-[11px] text-fog-600">loading…</div>
      )}
      {error && (
        <div className="font-mono text-[11px] text-molten">
          {(error as Error).message}
        </div>
      )}
      {data && (
        <div className="space-y-4">
          {/* Summary row */}
          <div className="flex items-center gap-6 hairline-b pb-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                cost
              </span>
              <span className="font-mono text-[11px] text-fog-200 tabular-nums">
                ${(data.costTotal).toFixed(2)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                tokens
              </span>
              <span className="font-mono text-[11px] text-fog-200 tabular-nums">
                {data.tokensTotal.toLocaleString()}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                pattern
              </span>
              <span className="font-mono text-[11px] text-fog-200 uppercase tracking-widest2">
                {data.pattern}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 ml-auto">
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 text-right">
                completion
              </span>
              <span className="font-mono text-[11px] text-mint tabular-nums text-right">
                {completionRate} ({data.todosCompleted}/{totalDone})
              </span>
            </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                  criteria
                </span>
                <span className="font-mono text-[11px] text-mint tabular-nums">
                  {data.criteriaMet} met
                  {data.criteriaUnmet > 0 && (
                    <span className="text-rust ml-1">{data.criteriaUnmet} unmet</span>
                  )}
                </span>
              </div>
          </div>

          {/* Agent table */}
          <table className="w-full">
            <thead>
              <tr className="hairline-b">
                <th className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 text-left pb-1.5 w-[26px]">
                  #
                </th>
                <th className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 text-left pb-1.5">
                  agent
                </th>
                <th className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 text-right pb-1.5 w-[64px]">
                  done
                </th>
                <th className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 text-right pb-1.5 w-[52px]">
                  stale
                </th>
                <th className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 text-right pb-1.5 w-[64px]">
                  rate
                </th>
                <th className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 text-left pb-1.5">
                  files
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {data.agents.map((agent, i) => {
                const total = agent.todosCompleted + agent.todosStale;
                const rate =
                  total > 0
                    ? `${Math.round((agent.todosCompleted / total) * 100)}%`
                    : '—';
                return (
                  <tr key={agent.sessionID} className="h-7">
                    <td className="font-mono text-[10px] text-fog-600 tabular-nums">
                      {i + 1}
                    </td>
                    <td className="font-mono text-[11px] text-fog-200 truncate max-w-[140px]">
                      {agent.name}
                    </td>
                    <td className="font-mono text-[10px] text-mint tabular-nums text-right">
                      {agent.todosCompleted}
                    </td>
                    <td className="font-mono text-[10px] text-amber tabular-nums text-right">
                      {agent.todosStale || '—'}
                    </td>
                    <td className="font-mono text-[10px] text-fog-400 tabular-nums text-right">
                      {rate}
                    </td>
                    <td className="font-mono text-[10px] text-fog-500 truncate max-w-[200px]">
                      {agent.filesEdited.join(', ') || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {data.agents.length === 0 && (
            <div className="font-mono text-[11px] text-fog-600 italic">
              no agents have claimed work yet
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
