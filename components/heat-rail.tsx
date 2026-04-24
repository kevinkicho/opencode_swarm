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
import { useMemo, useState } from 'react';
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

  // Phase 5.1 — view toggle between flat hot-first list and a
  // VSCode-style file tree grouped by directory. Tree mode preserves
  // the same heat data per leaf row; folder rows aggregate child
  // edits + recency. Default = list (existing behavior, keeps
  // muscle-memory for users on the previous build).
  const [view, setView] = useState<'list' | 'tree'>('list');

  const body =
    view === 'tree' ? (
      <HeatTreeView
        heat={heat}
        workspace={workspace}
        maxCount={maxCount}
        agentBySession={agentBySession}
        diffStatsByPath={diffStatsByPath}
        onSelect={onSelect}
      />
    ) : (
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

  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        heat
      </span>
      <span className="font-mono text-micro text-fog-700 tabular-nums">
        {heat.length} files
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <ViewToggleButton
          active={view === 'list'}
          onClick={() => setView('list')}
          label="list"
          tooltip="hot-first flat list"
        />
        <ViewToggleButton
          active={view === 'tree'}
          onClick={() => setView('tree')}
          label="tree"
          tooltip="grouped by directory"
        />
      </div>
    </div>
  );

  if (embedded) return <>{header}{body}</>;

  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden max-h-[320px] hairline-b bg-ink-850">
      {header}
      {body}
    </section>
  );
}

function ViewToggleButton({
  active,
  onClick,
  label,
  tooltip,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tooltip: string;
}) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'h-5 px-1.5 rounded font-mono text-micro uppercase tracking-widest2 transition cursor-pointer',
        active
          ? 'bg-ink-800 text-fog-100'
          : 'text-fog-600 hover:text-fog-200 hover:bg-ink-800/50',
      )}
    >
      {label}
    </button>
  );
  return (
    <Tooltip side="bottom" align="end" content={tooltip}>
      {btn}
    </Tooltip>
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

// Tree view (Phase 5.1 of IMPLEMENTATION_PLAN). Same heat data,
// grouped by directory and rendered as an indented hierarchical
// list. Folders aggregate child counts + recency; clicking a folder
// toggles expand/collapse. Files render compact inline with their
// intensity bar. Leaf rows still call onSelect to open the file
// inspector — same boundary as the list view.

interface TreeNode {
  type: 'dir' | 'file';
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  // Aggregated for dirs (sum of all descendant edits + max recency);
  // raw for files. Populated in buildTree.
  editCount: number;
  lastTouchedMs: number;
  fileCount: number;
  heat?: FileHeat;
}

function buildTree(heat: FileHeat[], workspace: string): TreeNode {
  const root: TreeNode = {
    type: 'dir',
    name: '/',
    fullPath: '',
    children: new Map(),
    editCount: 0,
    lastTouchedMs: 0,
    fileCount: 0,
  };

  for (const h of heat) {
    const stripped = stripWorkspace(h.path, workspace);
    const segments = stripped.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const isLeaf = i === segments.length - 1;
      const seg = segments[i];
      let next = cursor.children.get(seg);
      if (!next) {
        next = {
          type: isLeaf ? 'file' : 'dir',
          name: seg,
          fullPath: segments.slice(0, i + 1).join('/'),
          children: new Map(),
          editCount: 0,
          lastTouchedMs: 0,
          fileCount: 0,
          heat: isLeaf ? h : undefined,
        };
        cursor.children.set(seg, next);
      }
      cursor = next;
    }
  }

  // Aggregate counts via post-order. File nodes carry their own raw
  // editCount; directories sum descendants. Done iteratively to
  // avoid recursion depth surprises on deep trees.
  function aggregate(node: TreeNode): void {
    if (node.type === 'file' && node.heat) {
      node.editCount = node.heat.editCount;
      node.lastTouchedMs = node.heat.lastTouchedMs;
      node.fileCount = 1;
      return;
    }
    let count = 0;
    let last = 0;
    let files = 0;
    for (const child of node.children.values()) {
      aggregate(child);
      count += child.editCount;
      if (child.lastTouchedMs > last) last = child.lastTouchedMs;
      files += child.fileCount;
    }
    node.editCount = count;
    node.lastTouchedMs = last;
    node.fileCount = files;
  }
  aggregate(root);
  return root;
}

interface FlatRow {
  node: TreeNode;
  depth: number;
}

function flattenTree(
  root: TreeNode,
  expanded: Set<string>,
): FlatRow[] {
  const out: FlatRow[] = [];
  function visit(node: TreeNode, depth: number): void {
    if (node !== root) {
      out.push({ node, depth });
    }
    if (node.type === 'dir' && (node === root || expanded.has(node.fullPath))) {
      // Sort children: dirs first, then files; within each, hot-first.
      const kids = [...node.children.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        if (b.editCount !== a.editCount) return b.editCount - a.editCount;
        return a.name.localeCompare(b.name);
      });
      for (const kid of kids) visit(kid, depth + 1);
    }
  }
  visit(root, -1);
  return out;
}

function HeatTreeView({
  heat,
  workspace,
  maxCount,
  agentBySession,
  diffStatsByPath,
  onSelect,
}: {
  heat: FileHeat[];
  workspace: string;
  maxCount: number;
  agentBySession: Map<string, Agent>;
  diffStatsByPath: DiffStatsByPath;
  onSelect?: (heat: FileHeat) => void;
}) {
  const root = useMemo(() => buildTree(heat, workspace), [heat, workspace]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Default expansion: top-level dirs with the highest aggregate
    // edit counts. Avoids forcing the user to click N times to find
    // hot regions; deeper levels stay collapsed for compactness.
    const next = new Set<string>();
    const top = [...root.children.values()]
      .filter((c) => c.type === 'dir')
      .sort((a, b) => b.editCount - a.editCount)
      .slice(0, 3);
    for (const t of top) next.add(t.fullPath);
    return next;
  });

  const rows = useMemo(() => flattenTree(root, expanded), [root, expanded]);

  if (heat.length === 0) {
    return (
      <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
        <li className="px-3 py-2 font-mono text-micro uppercase tracking-widest2 text-fog-700">
          no file edits yet
        </li>
      </ul>
    );
  }

  function toggle(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
      {rows.map(({ node, depth }) => (
        <HeatTreeRow
          key={node.fullPath}
          node={node}
          depth={depth}
          maxCount={maxCount}
          agentBySession={agentBySession}
          diffStats={node.heat ? diffStatsByPath.get(node.heat.path) : undefined}
          isExpanded={node.type === 'dir' && expanded.has(node.fullPath)}
          onToggle={() => toggle(node.fullPath)}
          onSelectFile={onSelect}
        />
      ))}
    </ul>
  );
}

function HeatTreeRow({
  node,
  depth,
  maxCount,
  agentBySession,
  diffStats,
  isExpanded,
  onToggle,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  maxCount: number;
  agentBySession: Map<string, Agent>;
  diffStats?: { added: number; deleted: number };
  isExpanded: boolean;
  onToggle: () => void;
  onSelectFile?: (heat: FileHeat) => void;
}) {
  const intensity = node.editCount / maxCount;
  const barTone =
    intensity >= 0.8
      ? 'bg-molten/60'
      : intensity >= 0.5
        ? 'bg-molten/35'
        : intensity >= 0.2
          ? 'bg-amber/30'
          : 'bg-fog-700';

  const indent = depth * 12;
  const isDir = node.type === 'dir';

  function handleClick(): void {
    if (isDir) onToggle();
    else if (node.heat && onSelectFile) onSelectFile(node.heat);
  }

  const touchers = node.heat
    ? node.heat.sessionIDs
        .map((sid) => agentBySession.get(sid))
        .filter((a): a is Agent => a !== undefined)
    : [];

  return (
    <li className="relative min-w-0">
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        className="h-5 px-3 grid items-center gap-1.5 cursor-pointer hover:bg-ink-800/40 transition"
        style={{
          gridTemplateColumns: `${indent}px 12px 16px minmax(0, 1fr) 32px 36px`,
        }}
        title={node.fullPath}
      >
        <span /> {/* indent spacer */}
        {/* Disclosure chevron for dirs, blank for files. */}
        <span
          className={clsx(
            'font-mono text-[9px] text-fog-600 select-none',
            !isDir && 'invisible',
          )}
        >
          {isExpanded ? '▾' : '▸'}
        </span>
        {/* Intensity bar — dir + file both show one. Dir's reflects
            sum of descendant edits, normalized against the run-wide max. */}
        <span className="h-2 w-3 rounded-sm overflow-hidden bg-ink-900/60">
          <span
            className={clsx('block h-full transition-all', barTone)}
            style={{ width: `${Math.max(8, intensity * 100)}%` }}
          />
        </span>
        <span
          className={clsx(
            'font-mono text-[10.5px] truncate',
            isDir ? 'text-fog-300' : 'text-fog-200',
          )}
        >
          {node.name}
          {isDir && (
            <span className="ml-1 text-fog-700 normal-case text-[9px]">
              {node.fileCount} file{node.fileCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-fog-500 text-right">
          {node.editCount}×
        </span>
        <span className="font-mono text-[10px] tabular-nums text-fog-700 text-right">
          {fmtAgo(node.lastTouchedMs)}
        </span>
      </div>
    </li>
  );
}
