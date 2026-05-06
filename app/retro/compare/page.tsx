'use client';

import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { RetroCompareView } from '@/components/retro-compare';

type CompareResult = {
  swarmRunID: string;
  retro: import('@/lib/server/memory/types').RunRetro | null;
  agentRollups: import('@/lib/server/memory/types').AgentRollup[];
};

export default function RetroComparePage() {
  const sp = useSearchParams();
  const ids = sp.get('ids') ?? '';

  const { data, isLoading, error } = useQuery<CompareResult[]>({
    queryKey: ['compare', ids],
    queryFn: async () => {
      const res = await fetch(`/api/swarm/run/compare?ids=${encodeURIComponent(ids)}`);
      if (!res.ok) throw new Error(`compare fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: ids.split(',').filter(Boolean).length >= 2,
  });

  if (!ids) {
    return (
      <div className="min-h-screen bg-ink-900 text-fog-400 p-6 font-mono text-sm">
        Pass run IDs via <span className="text-fog-200">?ids=id1,id2</span>
      </div>
    );
  }

  if (isLoading) {
    return <div className="min-h-screen bg-ink-900 text-fog-600 p-6 font-mono text-sm">loading…</div>;
  }

  if (error || !data) {
    return <div className="min-h-screen bg-ink-900 text-rust p-6 font-mono text-sm">failed to load comparison</div>;
  }

  return <RetroCompareView runs={data} />;
}