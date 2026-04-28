// HeatTreeView + HeatTreeRow — tree view of file heat.
//
// Tree row renders each dir/file as a single h-5 line with intensity
// bar + name + edit count + last-touch ago. The view memoizes a tree
// from buildTree() and derives expand/collapse state per dir; the
// auto-expand heuristic (≤3 children = full expand, otherwise top-3
// hottest) keeps shallow trees readable while preventing wide ones
// from flooding.
//
// Lifted from heat-rail/sub-components.tsx 2026-04-28.

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import type { FileHeat } from '@/lib/opencode/transform';
import type { Agent } from '@/lib/swarm-types';
import { Tooltip } from '../ui/tooltip';
import { accentBadge, fmtAgo } from './utils';
import { buildTree, flattenTree, type TreeNode } from './tree';
import type { DiffStatsByPath } from './types';

export function HeatTreeView({
  heat,
  workspace,
  maxCount,
  agentBySession,
  diffStatsByPath,
  onSelect,
  coldPaths,
  coldLoading,
  coldError,
}: {
  heat: FileHeat[];
  workspace: string;
  maxCount: number;
  agentBySession: Map<string, Agent>;
  diffStatsByPath: DiffStatsByPath;
  onSelect?: (heat: FileHeat) => void;
  coldPaths: readonly string[] | null;
  coldLoading: boolean;
  coldError: string | null;
}) {
  const root = useMemo(
    () => buildTree(heat, workspace, coldPaths),
    [heat, workspace, coldPaths],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const next = new Set<string>();
    // Recursively auto-expand any dir whose subtree is small (≤3 child
    // dirs at each level). For shallow trees with one or two top-level
    // dirs (e.g. src/server), this fully expands so files are visible
    // without clicking. Earlier shape only expanded the top 3 by edit
    // count, leaving nested dirs (markets/, routes/) collapsed — every
    // run started with a tree that needed 2-4 clicks to see anything.
    function walk(node: typeof root): void {
      const childDirs = [...node.children.values()].filter((c) => c.type === 'dir');
      if (childDirs.length === 0) return;
      // Always expand the root level. Then auto-expand nested dirs if
      // siblings are few (≤3) — preserves fully-expanded for shallow
      // trees but avoids over-expanding wide ones.
      if (childDirs.length <= 3) {
        for (const c of childDirs) {
          next.add(c.fullPath);
          walk(c);
        }
      } else {
        // Wide tree — expand only the top-3 hottest, leave the rest
        // collapsed so the panel doesn't flood.
        const top = childDirs
          .sort((a, b) => b.editCount - a.editCount)
          .slice(0, 3);
        for (const c of top) next.add(c.fullPath);
      }
    }
    walk(root);
    return next;
  });

  const rows = useMemo(() => flattenTree(root, expanded), [root, expanded]);

  if (heat.length === 0 && (!coldPaths || coldPaths.length === 0)) {
    return (
      <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none">
        <li className="px-3 py-2 font-mono text-micro uppercase tracking-widest2 text-fog-700">
          {coldLoading
            ? 'loading workspace tree…'
            : coldError
              ? `tree fetch failed: ${coldError}`
              : 'no file edits yet'}
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
      <Tooltip
        content={
          <div className="space-y-1 max-w-[420px]">
            <div className="font-mono text-[10.5px] text-fog-200 break-all">
              {node.fullPath}
            </div>
            <div className="font-mono text-[10.5px] text-fog-400 tabular-nums">
              {new Date(node.lastTouchedMs).toLocaleString()}
            </div>
            <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 tabular-nums">
              {fmtAgo(node.lastTouchedMs)} ago
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
        >
          <span />
          <span
            className={clsx(
              'font-mono text-[9px] text-fog-600 select-none',
              !isDir && 'invisible',
            )}
          >
            {isExpanded ? '▾' : '▸'}
          </span>
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
      </Tooltip>
    </li>
  );
}
