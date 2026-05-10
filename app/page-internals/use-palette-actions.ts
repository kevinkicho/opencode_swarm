'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { PaletteAction } from '@/components/command-palette';
import type { SwarmRunStatus } from '@/lib/swarm-run-types';
import type { SwarmRunListRow } from '@/lib/swarm-run-types';

function ageHint(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export { ageHint };

export function usePaletteActions(
  swarmRunID: string | null,
  swarmRunStatus: SwarmRunStatus | null,
  swarmRuns: readonly SwarmRunListRow[],
): PaletteAction[] {
  const router = useRouter();

  return useMemo<PaletteAction[]>(() => {
    const out: PaletteAction[] = [];
    if (swarmRunID && swarmRunStatus && swarmRunStatus !== 'live' && swarmRunStatus !== 'unknown') {
      out.push({
        id: 'retro:current',
        group: 'open',
        label: 'retro · current run',
        hint: swarmRunID,
        tone: 'molten',
        onSelect: () => router.push(`/retro/${swarmRunID}`),
      });
    }
    const recent = [...swarmRuns]
      .filter(
        (r) =>
          r.meta.swarmRunID !== swarmRunID &&
          r.status !== 'live' &&
          r.status !== 'unknown'
      )
      .sort(
        (a, b) =>
          (b.lastActivityTs ?? b.meta.createdAt) -
          (a.lastActivityTs ?? a.meta.createdAt)
      )
      .slice(0, 8);
    for (const r of recent) {
      const directive = r.meta.directive?.split('\n', 1)[0]?.trim() ?? '';
      const teaser =
        directive.length > 64
          ? directive.slice(0, 64).replace(/\s+$/, '') + '…'
          : directive || '(no directive)';
      const age = ageHint(r.lastActivityTs ?? r.meta.createdAt);
      out.push({
        id: `retro:${r.meta.swarmRunID}`,
        group: 'recent retros',
        label: `retro · ${teaser}`,
        hint: `${r.meta.pattern} · ${age}`,
        tone: 'iris',
        onSelect: () => router.push(`/retro/${r.meta.swarmRunID}`),
      });
    }
    return out;
  }, [router, swarmRunID, swarmRunStatus, swarmRuns]);
}