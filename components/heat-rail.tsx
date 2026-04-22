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

export function HeatRail({
  heat,
  agents,
  workspace,
  embedded = false,
}: {
  heat: FileHeat[];
  agents: Agent[];
  // Workspace root — used to strip the common prefix from displayed
  // paths so rows are dense + readable. Passing empty string falls
  // back to showing full paths.
  workspace: string;
  embedded?: boolean;
}) {
  const agentById = new Map(agents.map((a) => [a.id, a]));
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
            agentById={agentById}
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
  agentById,
}: {
  heat: FileHeat;
  workspace: string;
  maxCount: number;
  agentById: Map<string, Agent>;
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
    .map((sid) => agentById.get(sid))
    .filter((a): a is Agent => a !== undefined);

  return (
    <li className="relative min-w-0">
      <div className="pl-3 pr-2 h-6 flex items-center gap-2 min-w-0">
        {/* Intensity bar — a fixed 22px column. Width scales with count. */}
        <Tooltip
          content={`${heat.editCount} edit${heat.editCount === 1 ? '' : 's'}`}
          side="right"
        >
          <span
            className="relative shrink-0 h-2 w-[22px] bg-ink-800 rounded-sm overflow-hidden cursor-default"
            aria-label={`intensity ${Math.round(intensity * 100)}%`}
          >
            <span
              className={clsx('absolute left-0 top-0 bottom-0', barTone)}
              style={{ width: `${Math.max(8, intensity * 100)}%` }}
            />
          </span>
        </Tooltip>

        {/* File path — basename bright, dir dim. The dir prefix uses
            `.truncate-left` (rtl-direction trick in globals.css) so it
            clips from the LEFT when it overflows; the basename sits in
            a shrink-0 span beside it so it's always visible. Prior
            single-span implementation didn't survive flex layout. */}
        <Tooltip
          content={
            <div className="font-mono text-[10.5px] text-fog-500 max-w-[420px] break-all">
              {heat.path}
            </div>
          }
          side="right"
        >
          <div className="flex items-baseline flex-1 min-w-0 overflow-hidden font-mono text-[11.5px] cursor-default">
            {dir && (
              <span className="text-fog-700 truncate-left min-w-0 flex-1 basis-0">
                <bdi>{dir}/</bdi>
              </span>
            )}
            <span className="text-fog-200 shrink-0">{base}</span>
          </div>
        </Tooltip>

        {/* Agent badges — one per distinct session that touched this file. */}
        <div className="shrink-0 flex items-center gap-0.5">
          {touchers.slice(0, 4).map((a) => (
            <Tooltip key={a.id} content={a.name} side="top">
              <span
                className={clsx(
                  'w-3 h-3 rounded-sm font-mono text-[8.5px] leading-none grid place-items-center cursor-default',
                  accentBadge[a.accent],
                )}
              >
                {a.glyph}
              </span>
            </Tooltip>
          ))}
          {touchers.length > 4 && (
            <span className="font-mono text-[9px] text-fog-600 pl-0.5 tabular-nums">
              +{touchers.length - 4}
            </span>
          )}
        </div>

        {/* Last-touched relative time. */}
        <Tooltip
          content={new Date(heat.lastTouchedMs).toISOString()}
          side="left"
        >
          <span className="shrink-0 font-mono text-[9px] text-fog-600 tabular-nums cursor-default w-6 text-right">
            {fmtAgo(heat.lastTouchedMs)}
          </span>
        </Tooltip>
      </div>
    </li>
  );
}
