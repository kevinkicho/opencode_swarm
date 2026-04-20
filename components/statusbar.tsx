'use client';

import type { SessionMeta } from '@/lib/types';
import { compact } from '@/lib/format';

export function Statusbar({ meta }: { meta: SessionMeta }) {
  return (
    <footer className="h-7 shrink-0 hairline-t bg-ink-900 flex items-center px-4 text-[11px] font-mono text-fog-600">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-mint" />
          <span className="text-fog-400">connected</span>
        </span>
        <span className="text-fog-800"> </span>
        <span>
          session <span className="text-fog-400">{meta.id}</span>
        </span>
        <span className="text-fog-800"> </span>
        <span>
          branch <span className="text-fog-400">{meta.branch}</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span>elapsed <span className="text-fog-400">{meta.elapsed}</span></span>
        <span className="text-fog-800"> </span>
        <span>{compact(meta.tokens)} tokens</span>
        <span className="text-fog-800"> </span>
        <span>{meta.cost}</span>
        <span className="text-fog-800"> </span>
        <span className="text-fog-700">palette</span>
        <span className="text-fog-700">branch</span>
        <span className="text-fog-700">detach</span>
      </div>
    </footer>
  );
}
