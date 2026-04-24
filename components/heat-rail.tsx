'use client';

// Heat rail — stigmergy v0. A read-only projection of which files the
// swarm has touched, sorted hot-first. Each row: intensity bar +
// basename + dir hint + agent-badges for each distinct toucher + edit
// count + last-touched relative time.
//
// Design stance: observation, never assignment (DESIGN.md §4.2). The
// rail tells the human "look, agents keep converging on src/auth/" —
// it does NOT let you reassign or pin a file. If the human wants the
// swarm to focus elsewhere, they nudge via the composer / directive,
// not via this panel.

import clsx from 'clsx';
import type { FileHeat } from '@/lib/opencode/transform';
import type { Agent } from '@/lib/swarm-types';
import { Tooltip } from './ui/tooltip';

// Strip the run's workspace prefix from a file path so rows don't all
// start with the same 52-char `C:/Users/.../reponame/` noise. Normalize
// slashes first because opencode paths use backslashes on Windows.
function stripWorkspace(path: string, workspace: string): string {
  const np = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const nw = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  if (nw && np.startsWith(nw + '/')) return np.slice(nw.length + 1);
  if (nw && np === nw) return '';
  return np;
}

const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentBadge: Record<Agent['accent'], string> = {
  molten: 'bg-molten/15 text-molten',
  mint: 'bg-mint/15 text-mint',
  iris: 'bg-iris/15 text-iris',
  amber: 'bg-amber/15 text-amber',
  fog: 'bg-fog-500/15 text-fog-400',
};

function splitPath(path: string): { dir: string; base: string } {
  // Normalize Windows-style backslashes so the split works cross-platform.
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return { dir: '', base: normalized };
  return { dir: normalized.slice(0, idx), base: normalized.slice(idx + 1) };
}

function fmtAgo(ms: number): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

export type DiffStatsByPath = Map<string, { added: number; deleted: number }>;

export function HeatRail({
  heat,
  agents,
  workspace,
  diffStatsByPath,
  onSelect,
  embedded = false,
}: {
  heat: FileHeat[];
  agents: Agent[];
  // Workspace root — used to strip the common prefix from displayed
  // paths so rows are dense + readable. Passing empty string falls
  // back to showing full paths.
  workspace: string;
  // Per-file add/delete line counts, sourced from the session's diff
  // at the page level. Empty map renders — / — placeholders.
  diffStatsByPath: DiffStatsByPath;
  // Row clicked — parent opens the file inspector with this heat
  // record. Optional so the component still works in read-only
  // contexts (e.g. a future retro view).
  onSelect?: (heat: FileHeat) => void;
  embedded?: boolean;
}) {
  // Heat entries carry raw opencode sessionIDs; agents are keyed by a
  // derived `ag_<name>_<last8>` id. Build a reverse map via agent.sessionID
  // so per-file toucher badges resolve correctly. Fallback to empty map
  // if an agent doesn't carry sessionID (mock fixtures).
  const agentBySession = new Map<string, Agent>();
  for (const a of agents) if (a.sessionID) agentBySession.set(a.sessionID, a);
  const maxCount = Math.max(1, ...heat.map((h) => h.editCount));

  const body = (
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
      {heat.length === 0 ? (
        <li className="px-3 py-2 font-mono text-micro uppercase tracking-widest2 text-fog-700">
          no file edits yet
        </li>
      ) : (
        heat.map((h) => (
          <HeatRow
            key={h.path}
            heat={h}
            workspace={workspace}
            maxCount={maxCount}
            agentBySession={agentBySession}
            diffStats={diffStatsByPath.get(h.path)}
            onSelect={onSelect}
          />
        ))
      )}
    </ul>
  );

  if (embedded) return body;

  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden max-h-[320px] hairline-b bg-ink-850">
      <div className="h-10 hairline-b px-4 flex items-center gap-2 bg-ink-850/80 backdrop-blur">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          heat
        </span>
        <span className="font-mono text-micro text-fog-700 tabular-nums">
          {heat.length} files
        </span>
      </div>
      {body}
    </section>
  );
}

function HeatRow({
  heat,
  workspace,
  maxCount,
  agentBySession,
  diffStats,
  onSelect,
}: {
  heat: FileHeat;
  workspace: string;
  maxCount: number;
  agentBySession: Map<string, Agent>;
  diffStats?: { added: number; deleted: number };
  onSelect?: (heat: FileHeat) => void;
}) {
  const displayPath = stripWorkspace(heat.path, workspace);
  const { dir, base } = splitPath(displayPath);
  const intensity = heat.editCount / maxCount; // 0..1
  // Stepped tone — continuous would be illegible in a narrow column.
  // Thresholds: 0–20% fog-800, 20–50% amber/20, 50–80% molten/30,
  // 80–100% molten/50. Intensity rails the eye to the hottest rows.
  const barTone =
    intensity >= 0.8
      ? 'bg-molten/60'
      : intensity >= 0.5
        ? 'bg-molten/35'
        : intensity >= 0.2
          ? 'bg-amber/30'
          : 'bg-fog-700';

  const touchers = heat.sessionIDs
    .map((sid) => agentBySession.get(sid))
    .filter((a): a is Agent => a !== undefined);

  return (
    <li className="relative min-w-0">
      {/* Grid layout so every row's columns line up on the same vertical
          axes — intensity bar, path (right-aligned), agent badges, time
          stamp. Earlier flex layout gave each row its own column widths
          based on content, which made scanning ragged. Whole row is
          clickable when a parent wired an onSelect handler; clicking
          opens the file inspector with this heat record. */}
      <div
        role={onSelect ? 'button' : undefined}
        tabIndex={onSelect ? 0 : undefined}
        onClick={onSelect ? () => onSelect(heat) : undefined}
        onKeyDown={
          onSelect
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(heat);
                }
              }
            : undefined
        }
        className={clsx(
          'px-3 h-6 min-w-0 transition-colors',
          onSelect && 'cursor-pointer hover:bg-ink-800/50',
        )}
        style={{
          display: 'grid',
          // Grid columns: intensity | path (flex, right-aligned) |
          // +added | -deleted. Agent-toucher info + last-touched time
          // moved into the path's tooltip — the stats columns carry
          // the numbers the user actually wants to scan.
          gridTemplateColumns: '22px minmax(0, 1fr) 32px 32px',
          alignItems: 'center',
          columnGap: '8px',
        }}
      >
        {/* Intensity bar — fixed 22px column, bar width scales with count. */}
        <Tooltip
          content={`${heat.editCount} edit${heat.editCount === 1 ? '' : 's'}`}
          side="right"
        >
          <span
            className="relative h-2 w-full bg-ink-800 rounded-sm overflow-hidden cursor-default"
            aria-label={`intensity ${Math.round(intensity * 100)}%`}
          >
            <span
              className={clsx('absolute left-0 top-0 bottom-0', barTone)}
              style={{ width: `${Math.max(8, intensity * 100)}%` }}
            />
          </span>
        </Tooltip>

        {/* Path — right-aligned so basenames end at a consistent vertical
            axis; `.truncate-left` pushes overflow (long ancestor dirs)
            off the LEFT side with an ellipsis, so the filename always
            stays visible. Tooltip carries the absolute path + list of
            sessions that touched it + last-touched time, so all three
            secondary facts remain one hover away. */}
        <Tooltip
          content={
            <div className="space-y-1 max-w-[420px]">
              {/* Relative path with run's workspace as root — the
                  absolute path wasn't adding information since every
                  row in the run shares the same prefix. */}
              <div className="font-mono text-[10.5px] text-fog-200 break-all">
                {displayPath || heat.path}
              </div>
              {/* Timestamp: date + time on one line, relative age
                  underneath. Separator dots dropped — whitespace is
                  enough. */}
              <div className="font-mono text-[10.5px] text-fog-400 tabular-nums">
                {new Date(heat.lastTouchedMs).toLocaleString()}
              </div>
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 tabular-nums">
                {fmtAgo(heat.lastTouchedMs)} ago
              </div>
              {touchers.length > 0 && (
                <div className="flex items-center gap-1 pt-0.5 flex-wrap">
                  <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
                    touched by
                  </span>
                  {touchers.map((a) => (
                    <span
                      key={a.id}
                      className={clsx(
                        'inline-flex items-center h-4 px-1 rounded-sm font-mono text-[9px] leading-none',
                        accentBadge[a.accent],
                      )}
                    >
                      {a.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          }
          side="right"
        >
          <span className="truncate-left font-mono text-[11.5px] cursor-default min-w-0 w-full">
            <bdi dir="ltr">
              {dir && <span className="text-fog-700">{dir}/</span>}
              <span className="text-fog-200">{base}</span>
            </bdi>
          </span>
        </Tooltip>

        {/* +added line count. Mint when > 0; blank when zero — `+0` was
            visual noise on add-only changes (e.g. pure-deletion file).
            Em-dash reserved for "diff hasn't loaded yet," distinct from
            zero. Tabular-nums keeps digits aligned across rows. */}
        <span
          className={clsx(
            'font-mono text-[10.5px] tabular-nums text-right',
            diffStats && diffStats.added > 0 ? 'text-mint' : 'text-fog-700',
          )}
        >
          {!diffStats ? '—' : diffStats.added > 0 ? `+${diffStats.added}` : ''}
        </span>

        {/* -deleted line count. Rust when > 0; blank when zero. */}
        <span
          className={clsx(
            'font-mono text-[10.5px] tabular-nums text-right',
            diffStats && diffStats.deleted > 0 ? 'text-rust' : 'text-fog-700',
          )}
        >
          {!diffStats ? '—' : diffStats.deleted > 0 ? `-${diffStats.deleted}` : ''}
        </span>
      </div>
    </li>
  );
}
