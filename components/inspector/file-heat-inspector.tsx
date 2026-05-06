'use client';

// FileHeatInspector + EmptyState — the non-message inspector bodies.
//
// Lifted from inspector/sub-components.tsx 2026-04-28.
//
// FileHeatInspector handles selection from the heat rail (stigmergy v0)
// — a file, not a message or agent. Shows what the swarm did to this
// file: how many times it was edited, which agents touched it, when,
// and the full workspace-absolute path. No "jump to" affordance yet —
// patches aren't individually addressable in the timeline, so there's
// nowhere to jump.
//
// EmptyState is the fallback render when nothing is focused.

import clsx from 'clsx';
import type { Agent } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import { useSessionDiff } from '@/lib/opencode/live/use-session';
import { parseUnifiedDiff } from '@/lib/opencode/transform/diffs';
import type { DiffData } from '@/lib/types';
import { DiffView } from '../diff-view';
import { Tooltip } from '../ui/tooltip';

export function EmptyState() {
  return (
    <div className="rounded-md hairline bg-ink-800/40 p-4 text-center">
      <div className="font-display italic text-[18px] text-fog-500 leading-tight">
        nothing selected
      </div>
      <div className="mt-2 font-mono text-micro text-fog-700 leading-relaxed opacity-20">
        click a message arrow or agent lane to inspect<br/>
        handoff tool calls tokens cost
      </div>
    </div>
  );
}

export function FileHeatInspector({
  heat,
  workspace,
  agents,
}: {
  heat: FileHeat;
  workspace: string;
  agents: Agent[];
}) {
  // Reverse sessionID → agent map (see heat-rail for the same pattern).
  const agentBySession = new Map<string, Agent>();
  for (const a of agents) if (a.sessionID) agentBySession.set(a.sessionID, a);
  const np = heat.path.replace(/\\/g, '/').replace(/\/+$/, '');
  const nw = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const relPath = nw && np.startsWith(nw + '/') ? np.slice(nw.length + 1) : np;
  const lastSlash = relPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : '';
  const base = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;

  const touchers = heat.sessionIDs
    .map((sid) => agentBySession.get(sid))
    .filter((a): a is Agent => !!a);

  const lastTouchedAgo = (() => {
    const diff = Date.now() - heat.lastTouchedMs;
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))} seconds ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} minutes ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hours ago`;
    return `${Math.round(diff / 86_400_000)} days ago`;
  })();

  return (
    <div className="space-y-3">
      {/* Eyebrow — what this panel is showing. Matches the pattern used
          by the other inspector bodies. */}
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
        file · heat
      </div>

      {/* Path — basename prominent, dir dim. Wraps across lines so long
          paths don't force horizontal scroll inside the drawer. */}
      <div className="font-mono text-[13px] leading-snug break-all">
        {dir && <span className="text-fog-700">{dir}</span>}
        <span className="text-fog-100">{base}</span>
      </div>

      {/* Stats row — edit count, distinct sessions, last touched. */}
      <div className="grid grid-cols-2 gap-2">
        <FileStat label="edits" value={String(heat.editCount)} />
        <FileStat label="sessions" value={`${heat.distinctSessions}`} />
      </div>

      {/* Last touched with absolute timestamp on hover. */}
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
          last touched
        </div>
        <Tooltip content={new Date(heat.lastTouchedMs).toISOString()} side="top">
          <div className="font-mono text-[12px] text-fog-300 mt-0.5 cursor-default">
            {lastTouchedAgo}
          </div>
        </Tooltip>
      </div>

      {/* Agents that touched this file. Badges match the roster accent. */}
      {touchers.length > 0 && (
        <div>
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 mb-1">
            touched by
          </div>
          <ul className="flex flex-col gap-1">
            {touchers.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 font-mono text-[11.5px]"
              >
                <span
                  className={clsx(
                    'w-3 h-3 rounded-sm font-mono text-[8.5px] leading-none grid place-items-center',
                    'bg-' + a.accent + '/15 text-' + a.accent,
                  )}
                >
                  {a.glyph}
                </span>
                <span className="text-fog-200">{a.name}</span>
                <span className="text-fog-700">·</span>
                <span className="text-fog-500">{a.model.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Absolute path — the full workspace-prefixed string, dim so it
          reads as reference. */}
      <div className="pt-1 hairline-t">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 mb-1">
          absolute
        </div>
        <div className="font-mono text-[10.5px] text-fog-600 break-all leading-snug">
          {heat.path}
        </div>
      </div>

      {/* Inline diff — fetches diffs from each session that touched this
          file, filters to just the selected path, and renders via DiffView.
          Each session's diff is a separate block; when multiple sessions
          touched the same file, this shows each one's contribution. */}
      <div className="pt-1 hairline-t">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700 mb-2">
          diff
        </div>
        <FileDiffSection filePath={heat.path} sessionIDs={heat.sessionIDs} />
      </div>
    </div>
  );
}

function FileStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">{label}</div>
      <div className="font-mono text-[12.5px] tabular-nums mt-0.5 text-fog-100">{value}</div>
    </div>
  );
}

// Renders per-session diffs filtered to a single file path. Each session
// gets its own diff block; when multiple sessions touched the same file,
// the user sees each contribution separately.
function FileDiffSection({
  filePath,
  sessionIDs,
}: {
  filePath: string;
  sessionIDs: string[];
}) {
  if (sessionIDs.length === 0) {
    return (
      <div className="font-mono text-[10.5px] text-fog-700">
        no sessions recorded
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {sessionIDs.slice(0, 3).map((sid) => (
        <SessionDiffBlock key={sid} sessionId={sid} filePath={filePath} />
      ))}
      {sessionIDs.length > 3 && (
        <div className="font-mono text-[10px] text-fog-700">
          +{sessionIDs.length - 3} more session{sessionIDs.length - 3 > 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

// Fetches a single session's diff and filters to the selected file.
// Uses useSessionDiff (TanStack Query) with 5-minute staleTime so
// re-opening the drawer doesn't re-fetch.
function SessionDiffBlock({
  sessionId,
  filePath,
}: {
  sessionId: string;
  filePath: string;
}) {
  const { diffs, loading, error } = useSessionDiff(sessionId, true, null);

  if (loading) {
    return (
      <div className="font-mono text-[10px] text-fog-700 animate-pulse">
        loading diff…
      </div>
    );
  }

  if (error) {
    return (
      <div className="font-mono text-[10px] text-rust">
        diff fetch failed: {error}
      </div>
    );
  }

  if (!diffs) {
    return (
      <div className="font-mono text-[10px] text-fog-700">
        no diff available
      </div>
    );
  }

  // Parse all session diffs, filter to just the selected file
  const matching: DiffData[] = [];
  for (const d of diffs) {
    if (d.file === filePath || d.file.endsWith('/' + filePath) || filePath.endsWith('/' + d.file)) {
      matching.push(parseUnifiedDiff(d.file, d.patch));
    }
  }

  // Also try matching with normalized paths (opencode may return
  // workspace-relative or absolute paths, and the heat path may be
  // absolute or workspace-relative)
  if (matching.length === 0) {
    const normalizedTarget = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    for (const d of diffs) {
      const normalizedFile = d.file.replace(/\\/g, '/').split('/').pop() ?? '';
      if (normalizedTarget && normalizedFile && normalizedTarget === normalizedFile) {
        matching.push(parseUnifiedDiff(d.file, d.patch));
      }
    }
  }

  if (matching.length === 0) {
    return (
      <div className="font-mono text-[10px] text-fog-700">
        file not in session diff
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {matching.map((diff) => (
        <DiffView key={diff.file} diff={diff} />
      ))}
    </div>
  );
}
