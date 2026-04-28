'use client';

// Cross-run comparison for one repo. Shows every run that targeted a
// given workspace, grouped into continuation chains so the reader sees
// which runs inherited from which. Per-run: pattern, status, age,
// duration, tier, tokens, cost.
//
// Data source: GET /api/swarm/run filtered client-side in the route
// page. Same SwarmRunListRow shape the run picker consumes.
//
// Aesthetic: dense factory — h-6 cards, monospace, tabular-nums, hairline
// borders, pattern accent palette. Sortable = deliberate no; chains
// have inherent order (parent → child by continuationOf) and standalone
// runs stack newest-first beneath.

import clsx from 'clsx';
import Link from 'next/link';
import { useMemo } from 'react';
import type { SwarmRunListRow, SwarmRunStatus } from '@/lib/swarm-run-types';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import { Tooltip } from './ui/tooltip';
import { STATUS_BURN_VISUAL } from './swarm-run-visual';

// Repo-run rows use the burn-rate palette (live=amber, idle=mint,
// stale=fog) — same mental model as projects-matrix, "who burned compute
// today." Picker uses a different palette (live=mint pulse) for "what's
// still attached to compute."
const STATUS_TONE = Object.fromEntries(
  Object.entries(STATUS_BURN_VISUAL).map(([k, v]) => [k, v.tone]),
) as Record<SwarmRunStatus, string>;

function fmtCost(n: number): string {
  if (n === 0) return '—';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n === 0) return '—';
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtAge(ms: number): string {
  const d = Math.floor(ms / 86_400_000);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(ms / 3_600_000);
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(ms / 60_000);
  if (m > 0) return `${m}m ago`;
  return `${Math.floor(ms / 1_000)}s ago`;
}

function fmtDuration(ms: number): string {
  if (ms < 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1_000)}s`;
}

interface Chain {
  // Ordered oldest → newest; root has no continuationOf, subsequent
  // entries each reference the previous as continuationOf.
  runs: SwarmRunListRow[];
}

// Build continuation chains. Runs with no continuationOf become roots;
// runs with continuationOf attach as children of their parent. Orphans
// (continuationOf points at a run we don't have) promote to their own
// root so they still render. Chain order within a root follows the
// continuation pointers, not timestamps — the pointer is authoritative.
function buildChains(rows: SwarmRunListRow[]): Chain[] {
  const byId = new Map<string, SwarmRunListRow>();
  for (const row of rows) byId.set(row.meta.swarmRunID, row);

  // Children adjacency: continuationOf → [child, child, …]. A fork
  // (two runs both continuing from the same parent) renders as two
  // separate chains branching from the shared prefix.
  const childrenOf = new Map<string, SwarmRunListRow[]>();
  for (const row of rows) {
    const parent = row.meta.continuationOf;
    if (!parent) continue;
    if (!byId.has(parent)) continue; // orphan
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(row);
  }

  const roots = rows.filter((r) => {
    const parent = r.meta.continuationOf;
    return !parent || !byId.has(parent);
  });
  // Newest-first root order. Chains within a fork render sequentially.
  roots.sort((a, b) => b.meta.createdAt - a.meta.createdAt);

  function walk(root: SwarmRunListRow): Chain[] {
    // DFS: walk children, emit one chain per leaf path. A single
    // parent with no children becomes a 1-element chain.
    const kids = childrenOf.get(root.meta.swarmRunID) ?? [];
    if (kids.length === 0) return [{ runs: [root] }];
    const out: Chain[] = [];
    for (const kid of kids) {
      for (const sub of walk(kid)) {
        out.push({ runs: [root, ...sub.runs] });
      }
    }
    return out;
  }

  const chains: Chain[] = [];
  for (const root of roots) {
    for (const chain of walk(root)) chains.push(chain);
  }
  return chains;
}

export function RepoRunsView({ rows }: { rows: SwarmRunListRow[] }) {
  const chains = useMemo(() => buildChains(rows), [rows]);

  // Per-chain aggregate: total cost, tokens, duration. The point of
  // the continuation feature is to see "this lineage has burned X over
  // Y hours" — that aggregate lives on the chain header.
  const now = Date.now();

  // Group chains by workspace when multiple are present (rare — duplicate
  // leaf names). Labels only render when >1 workspace is in play.
  const workspaces = Array.from(new Set(rows.map((r) => r.meta.workspace)));

  return (
    <div className="flex-1 overflow-auto">
      <ul className="flex flex-col gap-3 p-4">
        {chains.map((chain, idx) => {
          const chainCost = chain.runs.reduce((s, r) => s + r.costTotal, 0);
          const chainTokens = chain.runs.reduce((s, r) => s + r.tokensTotal, 0);
          const chainStart = chain.runs[0].meta.createdAt;
          const chainEnd = chain.runs[chain.runs.length - 1].lastActivityTs ?? now;
          const chainDuration = chainEnd - chainStart;
          const key = chain.runs.map((r) => r.meta.swarmRunID).join('>');
          const isChain = chain.runs.length > 1;

          return (
            <li
              key={`${key}-${idx}`}
              className="hairline rounded-md bg-ink-900/40 overflow-hidden"
            >
              {isChain && (
                <header className="px-3 h-6 flex items-center justify-between hairline-b bg-ink-850/40 font-mono text-micro uppercase tracking-widest2">
                  <span className="text-fog-500">
                    chain · {chain.runs.length} runs
                  </span>
                  <span className="text-fog-600 tabular-nums">
                    {fmtDuration(chainDuration)} · {fmtTokens(chainTokens)} · {fmtCost(chainCost)}
                  </span>
                </header>
              )}
              <ul className="flex flex-col">
                {chain.runs.map((run, rIdx) => (
                  <RunRow
                    key={run.meta.swarmRunID}
                    run={run}
                    continuationStep={isChain ? rIdx : undefined}
                    workspaces={workspaces.length > 1 ? workspaces : undefined}
                  />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      {workspaces.length > 1 && (
        <div className="px-4 py-2 hairline-t font-mono text-micro uppercase tracking-widest2 text-fog-700">
          note: {workspaces.length} workspaces share this repo leaf name
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  continuationStep,
  workspaces,
}: {
  run: SwarmRunListRow;
  continuationStep?: number;
  workspaces?: string[];
}) {
  const meta = run.meta;
  const pMeta = patternMeta[meta.pattern];
  const accentText = pMeta ? patternAccentText[pMeta.accent] : 'text-fog-400';
  const lastTs = run.lastActivityTs ?? meta.createdAt;
  const age = Date.now() - lastTs;
  const duration = lastTs - meta.createdAt;
  const continuationBadge = meta.continuationOf ? '↗' : '';

  return (
    <li className="h-7 flex items-center px-3 hairline-b last:border-b-0 hover:bg-ink-800/40 transition-colors">
      {continuationStep !== undefined && (
        <span className="font-mono text-micro text-fog-700 tabular-nums mr-2 w-4 text-right">
          {continuationStep === 0 ? '┌' : continuationStep + 1 === run.meta.sessionIDs.length ? '└' : '├'}
        </span>
      )}
      <Link
        // New tab — peer of the runs-picker pattern (2026-04-28).
        href={`/?swarmRun=${meta.swarmRunID}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 flex items-center gap-3 min-w-0"
        title={`open ${meta.swarmRunID} in new tab`}
      >
        <span className={clsx('font-mono text-[10.5px] uppercase tracking-widest2 w-24 shrink-0', accentText)}>
          {pMeta?.label ?? meta.pattern}
        </span>
        <span
          className={clsx(
            'font-mono text-[10.5px] uppercase tracking-widest2 w-14 shrink-0',
            STATUS_TONE[run.status]
          )}
        >
          {run.status}
        </span>
        {continuationBadge && (
          <Tooltip content="continued from a prior run via continuationOf" side="top">
            <span className="font-mono text-[10.5px] text-fog-500 tabular-nums w-4 shrink-0 cursor-default">
              {continuationBadge}
            </span>
          </Tooltip>
        )}
        <span className="font-mono text-[11px] text-fog-400 tabular-nums w-20 shrink-0 text-right">
          {fmtDuration(duration)}
        </span>
        <span className="font-mono text-[11px] text-fog-500 tabular-nums w-16 shrink-0 text-right">
          {fmtTokens(run.tokensTotal)}
        </span>
        <span className="font-mono text-[11px] text-fog-500 tabular-nums w-16 shrink-0 text-right">
          {fmtCost(run.costTotal)}
        </span>
        <span className="font-mono text-[11px] text-fog-700 tabular-nums w-14 shrink-0 text-right">
          {fmtAge(age)}
        </span>
        <Tooltip
          content={
            <div className="space-y-1 max-w-[360px]">
              <div className="font-mono text-[11px] text-fog-200">
                {meta.title ?? meta.directive?.split('\n', 1)[0] ?? meta.swarmRunID}
              </div>
              <div className="font-mono text-[10.5px] text-fog-600 break-all">
                {meta.swarmRunID}
              </div>
              {meta.continuationOf && (
                <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 break-all">
                  continues: {meta.continuationOf}
                </div>
              )}
              {workspaces && workspaces.length > 1 && (
                <div className="font-mono text-[10px] text-fog-500 break-all">
                  {meta.workspace}
                </div>
              )}
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 tabular-nums">
                {meta.sessionIDs.length} session{meta.sessionIDs.length === 1 ? '' : 's'}
              </div>
            </div>
          }
          side="left"
        >
          <span className="font-mono text-[11px] text-fog-400 truncate min-w-0 flex-1 cursor-default">
            {meta.title ?? meta.directive?.split('\n', 1)[0] ?? meta.swarmRunID}
          </span>
        </Tooltip>
      </Link>
    </li>
  );
}
