'use client';

import clsx from 'clsx';
import { Tooltip } from './ui/tooltip';
import { IconLogo, IconChevron, IconSpark } from './icons';
import type { SessionMeta } from '@/lib/types';
import { compact } from '@/lib/format';

export function Topbar({ meta, onOpenPalette }: { meta: SessionMeta; onOpenPalette: () => void }) {
  return (
    <header className="relative h-12 flex items-center hairline-b bg-ink-850/80 backdrop-blur-md">
      <div className="flex items-center gap-3 pl-4 pr-3 h-full hairline-r">
        <div className="flex items-center gap-2">
          <div className="relative w-6 h-6 grid place-items-center text-molten">
            <IconLogo size={22} />
            <span className="absolute -right-0.5 -top-0.5 w-1.5 h-1.5 rounded-full bg-molten shadow-glow-molten" />
          </div>
          <span className="font-display italic text-[17px] tracking-tight text-fog-100">
            opencode
          </span>
          <span className="font-mono text-micro uppercase tracking-widest2 text-molten">
             next
          </span>
        </div>
      </div>

      <nav className="flex items-center gap-2 pl-4 text-[12.5px] text-fog-500">
        <span className="font-mono text-2xs uppercase tracking-widest2 text-fog-700">sessions</span>
        <IconChevron size={11} className="text-fog-700" />
        <span className="text-fog-300 truncate max-w-[380px]">{meta.title}</span>
        <span className="w-px h-3 bg-ink-600 mx-2" />
        <span className="font-mono text-2xs text-fog-600">{meta.branch}</span>
      </nav>

      <div className="ml-auto flex items-center gap-3 pr-4 h-full">
         <Tooltip content="Quick jump to branch, filter, or command">
           <button
             onClick={onOpenPalette}
             className="group flex items-center gap-2 px-2.5 h-7 rounded-md bg-ink-800 hairline hover:border-ink-500 transition"
           >
             <span className="font-mono text-2xs text-fog-500 tracking-wider">filter jump branch</span>
           </button>
         </Tooltip>

        <div className="flex items-center gap-2 px-2.5 h-7 rounded-md hairline bg-ink-800">
          <span className="relative flex items-center">
            <span className="absolute inset-0 rounded-full bg-molten animate-pulse-ring" />
            <span className="relative w-1.5 h-1.5 rounded-full bg-molten" />
          </span>
          <span className="font-mono text-2xs text-fog-300">{meta.model}</span>
        </div>

        <div className="flex items-center gap-1.5 font-mono text-2xs text-fog-500">
          <IconSpark size={11} className="text-fog-600" />
          <span>{compact(meta.tokens)}</span>
          <span className="w-px h-3 bg-ink-600 mx-1" />
          <span>{meta.cost}</span>
        </div>

        <div className="w-7 h-7 rounded-md hairline bg-ink-800 grid place-items-center font-mono text-2xs text-fog-300">
          kk
        </div>
      </div>

      <div
        aria-hidden
        className={clsx(
          'absolute left-0 right-0 bottom-0 h-px',
          'bg-gradient-to-r from-transparent via-molten/30 to-transparent opacity-40'
        )}
      />
    </header>
  );
}
