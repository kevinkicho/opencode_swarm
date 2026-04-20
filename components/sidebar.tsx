'use client';

import clsx from 'clsx';
import { IconPlus, IconTerminal, IconAgent } from './icons';
import type { RecentSession, SessionMeta } from '@/lib/types';

const statusColor: Record<RecentSession['status'], string> = {
  active: 'bg-molten shadow-glow-molten',
  complete: 'bg-mint',
  paused: 'bg-fog-600',
  error: 'bg-rust',
};

export function Sidebar({
  sessions,
  activeId,
  meta,
}: {
  sessions: RecentSession[];
  activeId: string;
  meta: SessionMeta;
}) {
  return (
    <aside className="relative w-[248px] shrink-0 hairline-r bg-ink-850 flex flex-col">
      <div className="p-3 hairline-b">
        <button className="group w-full flex items-center gap-2 h-9 px-2.5 rounded-md bg-ink-800 hairline hover:border-ink-500 transition">
          <IconPlus size={13} className="text-molten" />
          <span className="text-[12.5px] text-fog-200">new session</span>
        </button>
      </div>

      <div className="px-3 py-2 flex items-center justify-between">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
          recent 6
        </span>
        <span className="font-mono text-micro text-fog-700">today</span>
      </div>

      <ul className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
        {sessions.map((s) => {
          const active = s.id === activeId;
          return (
            <li key={s.id}>
              <button
                className={clsx(
                  'group w-full text-left rounded-md px-2.5 py-2 transition relative',
                  active
                    ? 'bg-ink-700/70 hairline border-ink-500'
                    : 'hover:bg-ink-800/60'
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-molten rounded-r" />
                )}
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'w-1.5 h-1.5 rounded-full shrink-0',
                      statusColor[s.status]
                    )}
                  />
                  <span
                    className={clsx(
                      'text-[12.5px] truncate flex-1',
                      active ? 'text-fog-100' : 'text-fog-400 group-hover:text-fog-200'
                    )}
                  >
                    {s.title}
                  </span>
                </div>
                <div className="mt-1 pl-3.5 flex items-center gap-2 font-mono text-micro text-fog-700">
                  <span>{s.ago}</span>
                  <span className="text-fog-800"> </span>
                  <span>{s.model}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="hairline-t p-3 space-y-2">
        <div className="flex items-center gap-2 text-[11.5px] text-fog-500">
          <IconAgent size={12} className="text-iris" />
          <span>0 agents running</span>
          <span className="ml-auto font-mono text-micro text-fog-700">idle</span>
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-fog-500">
          <IconTerminal size={12} className="text-mint" />
          <span className="font-mono text-2xs truncate">{meta.cwd}</span>
        </div>
      </div>
    </aside>
  );
}
