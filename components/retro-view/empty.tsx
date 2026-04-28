'use client';

// Empty-retro state — what the page renders when there's no rollup yet.
//
// Surfaces a clickable "generate rollup" button (#7.Q20) so a user
// who lands on a retro for an old run that finished before auto-rollup
// shipped can fire one without leaving the page. Mutation-driven; the
// onSuccess does a full reload so the freshly-written rollups + retro
// hydrate from the server.
//
// Lifted from retro-view.tsx 2026-04-28. Pure UI; the only state is
// the local mutation state in RollupGenerateButton.

import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';

export function EmptyRetro({ swarmRunID }: { swarmRunID: string }) {
  return (
    <div className="min-h-screen bg-ink-900 text-fog-100 flex flex-col">
      <header className="h-10 hairline-b bg-ink-850/80 backdrop-blur flex items-center gap-3 px-4">
        <Link
          href="/"
          className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition"
        >
          ← runs
        </Link>
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">retro</span>
        <span className="font-mono text-[10.5px] tabular-nums text-fog-400 truncate">
          {swarmRunID}
        </span>
      </header>
      <div className="flex-1 flex items-center justify-center px-6">
        <GenerateRollupCard swarmRunID={swarmRunID} />
      </div>
    </div>
  );
}

// #7.Q20 — clickable empty-state. Rollups now auto-fire at run-end, but
// runs that finished before that ship (or runs whose stop crashed) still
// land here. The button POSTs to the rollup endpoint and reloads on
// success so the user sees the retro one click later instead of needing
// the curl from the comment.
function GenerateRollupCard({ swarmRunID }: { swarmRunID: string }) {
  return (
    <div className="max-w-[520px] space-y-3 hairline rounded bg-ink-850 px-5 py-6">
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
        no rollup yet
      </div>
      <p className="font-mono text-[12px] text-fog-300 leading-relaxed">
        This run has no L2 rollup recorded yet. Newer runs auto-fire one at
        run-end; older runs need a manual generate. Click below to fire it
        now (~1-3s for typical runs):
      </p>
      <RollupGenerateButton swarmRunID={swarmRunID} />
      <p className="font-mono text-[10.5px] text-fog-700 pt-1">
        Or from the terminal:
      </p>
      <pre className="font-mono text-[10.5px] bg-ink-900 rounded hairline px-3 py-2 text-fog-500 overflow-x-auto">
{`curl -X POST http://localhost:3000/api/swarm/memory/rollup \\
  -H 'content-type: application/json' \\
  -d '{"swarmRunID":"${swarmRunID}"}'`}
      </pre>
    </div>
  );
}

function RollupGenerateButton({ swarmRunID }: { swarmRunID: string }) {
  // mutation + manual error label. Pre-fix the click handler grabbed
  // the active element by side effect, mutated its disabled+textContent
  // imperatively, and reloaded the page on success. Now state is React-
  // managed and the imperative DOM mutation smell is gone.
  const rollupMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch('/api/swarm/memory/rollup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ swarmRunID }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      // Same UX as before — full reload to pick up the freshly-written
      // rollups + retro from the server. Could be improved to hit the
      // canonical TanStack queryKey once retros migrate.
      window.location.reload();
    },
  });
  const label = rollupMutation.isPending
    ? 'generating…'
    : rollupMutation.isError
      ? `error: ${(rollupMutation.error as Error)?.message ?? 'unknown'} — retry`
      : 'generate rollup';
  return (
    <button
      type="button"
      onClick={() => rollupMutation.mutate()}
      disabled={rollupMutation.isPending}
      className="w-full h-7 px-3 rounded font-mono text-[11px] uppercase tracking-widest2 cursor-pointer bg-ink-800 hairline text-fog-200 hover:border-mint/40 hover:text-mint transition disabled:cursor-wait disabled:opacity-70"
    >
      {label}
    </button>
  );
}
