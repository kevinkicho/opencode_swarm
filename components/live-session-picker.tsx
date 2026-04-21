'use client';

import Link from 'next/link';
import { Popover } from './ui/popover';
import { useLiveSessions } from '@/lib/opencode/live';

function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function LiveSessionPicker({ title }: { title: string }) {
  const { data, error, loading } = useLiveSessions(3000);
  const sessions = data?.sessions ?? [];

  const statusLabel = error
    ? 'offline'
    : loading && !data
      ? 'scanning…'
      : `${sessions.length} live`;

  return (
    <Popover
      side="bottom"
      align="start"
      width={460}
      content={(close) => (
        <div className="flex flex-col min-h-0">
          <div className="px-3 py-2 hairline-b flex items-center justify-between">
            <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
              recent opencode sessions
            </span>
            <span className="font-mono text-[10px] text-fog-700 tabular-nums">
              {statusLabel}
            </span>
          </div>
          <ul className="max-h-[360px] overflow-y-auto divide-y divide-ink-800">
            {error && !loading && (
              <li className="px-3 py-2 text-[11px] text-rust break-all">{error}</li>
            )}
            {sessions.slice(0, 30).map((s) => (
              <li key={s.id}>
                <Link
                  href={`/debug/opencode/session/${s.id}`}
                  onClick={() => close()}
                  className="px-3 h-7 flex items-center gap-3 hover:bg-ink-800/60 transition"
                >
                  <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-700 w-[96px] truncate shrink-0">
                    {s.slug}
                  </span>
                  <span className="text-[11.5px] text-fog-200 truncate flex-1 min-w-0">
                    {s.title}
                  </span>
                  <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0">
                    {fmtAge(s.time.updated)}
                  </span>
                </Link>
              </li>
            ))}
            {!loading && !error && sessions.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-fog-600">no sessions found</li>
            )}
          </ul>
        </div>
      )}
    >
      <button className="inline-flex items-center gap-1.5 min-w-0 group max-w-full cursor-pointer">
        <span className="text-fog-200 group-hover:text-fog-100 truncate transition">
          {title}
        </span>
        <span className="font-mono text-[9px] text-fog-700 group-hover:text-fog-500 transition shrink-0">
          ▾
        </span>
      </button>
    </Popover>
  );
}
