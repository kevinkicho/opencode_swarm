'use client';

// Footer status rail. Health dot + cross-run navigation buttons (new run,
// runs picker, cost, metrics, projects) on the left; per-run actions
// (palette, routing, provenance, glossary, history) on the right.
//
// Lifted out of app/page.tsx 2026-04-25 as part of the page.tsx
// decomposition (#84) — already a self-contained function with its own
// useOpencodeHealth hook, no shared state with PageBody beyond callback
// props. Moving it shrinks page.tsx by ~220 lines and lets the rail be
// re-used by future pages (e.g. /metrics, /projects) that want the
// same chrome without the swarm-run wiring.

import { useOpencodeHealth } from '@/lib/opencode/live';
import { SwarmRunsPicker } from '@/components/swarm-runs-picker';
import { Tooltip } from '@/components/ui/tooltip';
import { IconBranch } from '@/components/icons';

export function StatusRail({
  onOpenPalette,
  onOpenRouting,
  onOpenHistory,
  onOpenGlossary,
  onOpenDiagnostics,
  onOpenNewRun,
  onOpenProvenance,
  onOpenCost,
  onOpenMetrics,
  onOpenProjects,
  swarmRunID,
}: {
  onOpenPalette: () => void;
  onOpenRouting: () => void;
  onOpenHistory: () => void;
  onOpenGlossary: () => void;
  onOpenDiagnostics: () => void;
  onOpenNewRun: () => void;
  onOpenProvenance: (() => void) | null;
  onOpenCost: () => void;
  onOpenMetrics: () => void;
  onOpenProjects: () => void;
  swarmRunID: string | null;
}) {
  const health = useOpencodeHealth(5000);
  const dotClass =
    health.status === 'live'
      ? 'bg-mint'
      : health.status === 'offline'
        ? 'bg-rust'
        : 'bg-fog-700 animate-pulse';
  const label =
    health.status === 'live'
      ? 'swarm live'
      : health.status === 'offline'
        ? 'swarm offline'
        : 'connecting…';
  const healthTooltip =
    health.status === 'live'
      ? `opencode reachable · ${health.projectCount} project${health.projectCount === 1 ? '' : 's'}`
      : health.status === 'offline'
        ? health.error
          ? `opencode unreachable: ${health.error}`
          : 'opencode unreachable'
        : 'probing opencode…';

  return (
    <footer className="h-7 shrink-0 hairline-t bg-ink-900 flex items-center px-4 text-[11px] font-mono text-fog-600">
      <div className="flex items-center gap-3">
        <Tooltip content={healthTooltip} side="top">
          <span className="flex items-center gap-1.5 cursor-default">
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            <span className="text-fog-400">{label}</span>
          </span>
        </Tooltip>
        <span className="w-px h-3 bg-ink-700" />
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">initiate a new run</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                source + optional directive + optional team
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenNewRun}
            className="flex items-center gap-1.5 h-5 px-1.5 rounded bg-molten/10 hover:bg-molten/20 text-molten border border-molten/25 transition"
          >
            <span className="w-1 h-1 rounded-full bg-molten" />
            <span className="font-mono text-[10px] uppercase tracking-widest2">new run</span>
          </button>
        </Tooltip>
        <SwarmRunsPicker currentSwarmRunID={swarmRunID}>
          <button
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="browse swarm runs"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">runs</span>
            <span className="font-mono text-[9px] text-fog-700">▴</span>
          </button>
        </SwarmRunsPicker>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">cross-run cost</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                $ / tokens across every persisted run · by workspace + top spenders
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenCost}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="open cost dashboard"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">cost</span>
          </button>
        </Tooltip>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">cross-preset metrics</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                aggregates per pattern · avg duration, tokens, cost, stale%
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenMetrics}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="open cross-preset metrics"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">metrics</span>
          </button>
        </Tooltip>
        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">project-time matrix</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                every repo × every day · run markers colored by status
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenProjects}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            aria-label="open project-time matrix"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest2">projects</span>
          </button>
        </Tooltip>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip
          side="top"
          content={
            <span className="font-mono text-[11px] text-fog-200">
              open palette{' '}
              <span className="text-fog-500">⌘K / Ctrl+K</span>
            </span>
          }
        >
          <button
            onClick={onOpenPalette}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">palette</span>
          </button>
        </Tooltip>

        <Tooltip content="routing rules" side="top">
          <button
            onClick={onOpenRouting}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">routing</span>
          </button>
        </Tooltip>

        {onOpenProvenance && (
          <Tooltip
            side="top"
            wide
            content={
              <div className="space-y-0.5">
                <div className="font-mono text-[11px] text-fog-200">run provenance</div>
                <div className="font-mono text-[10.5px] text-fog-600">
                  L0 event log for this swarm run · replay + live
                </div>
              </div>
            }
          >
            <button
              onClick={onOpenProvenance}
              className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
            >
              <span className="text-fog-700">provenance</span>
            </button>
          </Tooltip>
        )}

        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">opencode vocabulary</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                canonical part, tool, and event names
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenGlossary}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">glossary</span>
          </button>
        </Tooltip>

        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">opencode diagnostics</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                tool catalog · MCP servers · effective config · user commands
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenDiagnostics}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">diagnostics</span>
          </button>
        </Tooltip>

        <Tooltip content="branch history" side="top">
          <button
            onClick={onOpenHistory}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <IconBranch size={10} className="text-fog-500" />
            <span className="text-fog-700">history</span>
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
