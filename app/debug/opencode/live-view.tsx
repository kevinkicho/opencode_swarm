'use client';

import Link from 'next/link';
import { useLiveSessions } from '@/lib/opencode/live';

function fmtAge(ms: number): string {
  const delta = Date.now() - ms;
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function LiveView({ baseUrl }: { baseUrl: string }) {
  const { data, error, loading } = useLiveSessions(3000);

  return (
    <main className="min-h-screen bg-ink-950 text-fog-200 font-mono p-8">
      <div className="max-w-[1100px] mx-auto space-y-6">
        <header className="space-y-1">
          <div className="text-micro uppercase tracking-widest2 text-fog-600 flex items-center gap-2">
            <span>debug / opencode / phase 1 probe</span>
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                error ? 'bg-rust' : data ? 'bg-mint shadow-glow-mint animate-pulse' : 'bg-fog-700'
              }`}
            />
            <span className="text-fog-700 normal-case tracking-normal text-[10px]">
              {error
                ? 'error'
                : data
                ? `live · tick ${fmtAge(data.lastUpdated)}`
                : loading
                ? 'connecting…'
                : 'idle'}
            </span>
          </div>
          <h1 className="text-lg text-fog-100">live projects + sessions</h1>
          <div className="text-[11px] text-fog-600">
            source: <span className="text-fog-400">{baseUrl}</span>
            <span className="text-fog-700"> · poll 3s · via /api/opencode proxy</span>
          </div>
        </header>

        {error ? (
          <section className="rounded hairline bg-rust/10 border border-rust/30 p-3 space-y-1">
            <div className="text-[12px] text-rust">fail</div>
            <div className="text-[11px] text-fog-300 break-all">{error}</div>
          </section>
        ) : !data ? (
          <section className="rounded hairline bg-ink-900/40 p-3 text-[11px] text-fog-600">
            loading…
          </section>
        ) : (
          <>
            <section className="space-y-2">
              <div className="text-micro uppercase tracking-widest2 text-fog-600">
                projects · {data.projects.length}
              </div>
              <ul className="divide-y divide-ink-800 hairline rounded overflow-hidden bg-ink-900/40">
                {data.projects.map((p) => (
                  <li key={p.id} className="px-3 h-6 flex items-center gap-3">
                    <span className="text-[10px] uppercase tracking-widest2 text-fog-700 w-12 truncate">
                      {p.vcs ?? '—'}
                    </span>
                    <span className="text-[11.5px] text-fog-200 truncate flex-1 min-w-0">
                      {p.worktree}
                    </span>
                    <span className="text-[10px] text-fog-700 tabular-nums">
                      {p.id.slice(0, 7)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <div className="text-micro uppercase tracking-widest2 text-fog-600">
                sessions · {data.sessions.length}
              </div>
              <ul className="divide-y divide-ink-800 hairline rounded overflow-hidden bg-ink-900/40">
                {data.sessions.slice(0, 30).map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/debug/opencode/session/${s.id}`}
                      className="px-3 h-6 flex items-center gap-3 hover:bg-ink-800/60 transition"
                    >
                      <span className="text-[10px] uppercase tracking-widest2 text-fog-700 w-[90px] truncate">
                        {s.slug}
                      </span>
                      <span className="text-[11.5px] text-fog-200 truncate flex-1 min-w-0">
                        {s.title}
                      </span>
                      <span className="text-[10px] text-fog-600 tabular-nums w-20 text-right">
                        {fmtAge(s.time.updated)}
                      </span>
                      <span className="text-[10px] text-fog-700 tabular-nums">
                        {s.id.slice(0, 7)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {data.sessions.length > 30 && (
                <div className="text-[10px] text-fog-600">
                  showing 30 of {data.sessions.length}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
