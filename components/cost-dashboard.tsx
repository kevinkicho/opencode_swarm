'use client';

// Cross-run cost + token dashboard.
//
// This is the first surface that aggregates across every persisted run
// rather than scoping to one. It exists to answer "where's my spend
// going this week?" without having to open each run individually.
//
// Design choices:
//   - Single read source (useSwarmRuns). The list endpoint already folds
//     cost/tokens into every row via deriveRunRow (see swarm-registry.ts),
//     so the dashboard is a pure client-side projection — no second fan-
//     out, no new endpoint.
//   - Dense sections, one story each: totals / sparkline / per-workspace
//     / top-5 expensive. A user scanning this should be able to answer
//     "is the spend where I expect" in under 10 seconds.
//   - Read-only. Mutation of runs (delete, archive) is explicitly out of
//     scope here — retention is a backend concern per DESIGN.md §7.7.
//
// 2026-04-28 decomposition: pure helpers + deriveAggregates →
// cost-dashboard/helpers.ts; the 4 visual sub-views →
// cost-dashboard/sub-views.tsx. This file is the dashboard shell.

import { useMemo } from 'react';
import { Drawer } from './ui/drawer';
import { useSwarmRuns } from '@/lib/opencode/live';
import {
  deriveAggregates,
  formatMoney,
  formatTokens,
} from './cost-dashboard/helpers';
import {
  TopExpensive,
  TotalCell,
  WeeklySparkline,
  WorkspaceBreakdown,
} from './cost-dashboard/sub-views';

export function CostDashboard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Poll at 4s while the drawer is open. The "always poll to warm the
  // cache" design from 2026-04 was audited out in the 2026-04-24
  // perf:cold run — CostDashboard's always-mounted dynamic() wrapper
  // (not gated on `open`) caused this hook to fire every 4s on every
  // page load, chewing through browser connection slots for a drawer
  // the user may never open. Gated via `enabled: open` now; first
  // fetch fires on drawer-open, TanStack Query serves stale cache
  // instantly if the picker has already fetched in the same window.
  const { rows, error, loading, lastUpdated } = useSwarmRuns({
    intervalMs: 4000,
    enabled: open,
  });

  const derived = useMemo(() => deriveAggregates(rows), [rows]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      eyebrow="cross-run cost"
      title="spend & tokens"
      width={520}
    >
      <div className="flex flex-col min-h-0 h-full">
        <div className="px-4 py-2.5 hairline-b flex items-center gap-3 bg-ink-900/40">
          <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
            totals
          </span>
          <span className="font-mono text-[11px] text-fog-700 ml-auto tabular-nums">
            {loading && lastUpdated === null
              ? 'scanning…'
              : error
                ? <span className="text-rust break-all">{error}</span>
                : `${rows.length} ${rows.length === 1 ? 'run' : 'runs'}`}
          </span>
        </div>

        <div className="px-4 py-3 hairline-b grid grid-cols-3 gap-3">
          <TotalCell label="$ spent" value={formatMoney(derived.costTotal)} tone="molten" />
          <TotalCell label="tokens" value={formatTokens(derived.tokensTotal)} tone="iris" />
          <TotalCell label="live now" value={String(derived.liveCount)} tone={derived.liveCount > 0 ? 'mint' : 'fog'} />
        </div>

        {/* Bundle-model banner: if any row has tokens > 0 but $0, the
            model is likely a Zen subscription bundle (big-pickle etc.)
            where the per-token price is $0 and the real cost is
            subscription-metered elsewhere. Without this note a pure-
            bundle fleet reads as "$0.00 for 20M tokens — something
            broken." Appears only when the signal is actually present. */}
        {derived.costTotal === 0 && derived.tokensTotal > 0 && (
          <div className="px-4 py-2 hairline-b flex items-center gap-2 bg-ink-900/40">
            <span className="font-mono text-[10px] text-fog-500">🏷️</span>
            <span className="font-mono text-[10.5px] text-fog-400 leading-snug">
              zero <span className="text-fog-600">$ spent</span> is expected
              for bundle-priced models (big-pickle / zen subscription) —
              per-token price is zero; subscription cost is billed
              separately by opencode.
            </span>
          </div>
        )}

        <WeeklySparkline buckets={derived.weekly} maxCost={derived.weeklyMax} />

        <WorkspaceBreakdown rows={derived.byWorkspace} />

        <TopExpensive rows={derived.topExpensive} />

        {!loading && rows.length === 0 && !error && (
          <div className="px-4 py-6 text-[11px] text-fog-600 flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-fog-700" />
            no runs yet — start one from the new run button in the status rail
          </div>
        )}
      </div>
    </Drawer>
  );
}
