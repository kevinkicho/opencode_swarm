'use client';

// Dedicated screen for a dead ?swarmRun= link. Deliberately *not* rendered
// inside the normal chrome — we don't want the topbar/timeline to tease a
// live-looking view over stale state. The two exits point at the recoverable
// next actions: strip the param (go home / mock view) or start a fresh run.
//
// Lifted out of app/page.tsx 2026-04-25 (#84). Self-contained, no shared
// state with PageBody, no shared imports beyond Tailwind classes.

export function RunNotFoundScreen({ swarmRunID }: { swarmRunID: string }) {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-ink-900 bg-noise">
      <div className="w-[420px] hairline rounded bg-ink-900/60 shadow-lg">
        <div className="px-4 h-7 hairline-b flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-rust" />
          <span className="font-mono text-micro uppercase tracking-widest2 text-rust">
            run not found
          </span>
        </div>
        <div className="px-4 py-3 hairline-b space-y-2">
          <div className="font-mono text-[11px] text-fog-400 leading-relaxed">
            no swarm run matches this id. the link may be stale, the run may
            have been deleted, or the id may have a typo.
          </div>
          <div className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1 items-baseline">
            <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
              run id
            </span>
            <span className="font-mono text-[11px] text-fog-200 truncate tabular-nums" title={swarmRunID}>
              {swarmRunID}
            </span>
          </div>
        </div>
        <div className="px-4 py-2.5 flex items-center gap-2">
          <a
            href="/"
            className="h-6 px-2 rounded hairline bg-ink-900 hover:bg-ink-800 font-mono text-[10px] uppercase tracking-widest2 text-fog-400 hover:text-fog-200 transition flex items-center"
          >
            clear link
          </a>
          <span className="ml-auto font-mono text-[10px] text-fog-700">
            or start a new run from the status rail
          </span>
        </div>
      </div>
    </div>
  );
}
