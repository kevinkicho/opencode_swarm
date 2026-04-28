// Pure helpers + constants + types for the ProjectsMatrix view.
//
// Lifted from components/projects-matrix.tsx 2026-04-28. No React,
// no DOM — date math, workspace→repo derivation, run-grouping, and
// the cell-geometry constants the matrix and its sub-views share.

import type { SwarmRunListRow, SwarmRunStatus } from '@/lib/swarm-run-types';
import { STATUS_BURN_VISUAL, STATUS_PRIORITY } from '../swarm-run-visual';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 30;

// Fixed cell geometry. Day column narrows on smaller windows; we don't
// scale — readers learn the pitch once and scanning is spatial.
export const DAY_WIDTH = 16;
export const ROW_HEIGHT = 20;
export const REPO_COL_WIDTH = 200;

// Day cells use the burn-rate palette (live=amber, idle=mint, stale=fog)
// because this view's mental model is "who burned compute today."
export const STATUS_TONE = Object.fromEntries(
  Object.entries(STATUS_BURN_VISUAL).map(([k, v]) => [k, v.bg]),
) as Record<SwarmRunStatus, string>;
export const STATUS_DOT_TONE = Object.fromEntries(
  Object.entries(STATUS_BURN_VISUAL).map(([k, v]) => [k, v.tone]),
) as Record<SwarmRunStatus, string>;

export function repoNameOf(workspace: string): string {
  // Workspace is always an absolute path; the repo is the leaf dir. Both
  // forward and back slashes may appear (opencode records Windows paths
  // with forward slashes per /api/swarm/run POST normalizer, but cross-
  // platform defensive).
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').pop() ?? '';
  return leaf || workspace;
}

export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function fmtDayShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDayLong(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export interface Project {
  workspace: string;
  repoName: string;
  source?: string;
  runs: SwarmRunListRow[];
  firstRunAt: number;
  lastRunAt: number;
}

// Group rows by workspace, sort runs desc within each, sort projects by
// most-recent activity. O(N log N) in the number of runs — fine at
// prototype scale (hundreds).
export function groupByWorkspace(rows: SwarmRunListRow[]): Project[] {
  const byWs = new Map<string, Project>();
  for (const row of rows) {
    const ws = row.meta.workspace;
    let proj = byWs.get(ws);
    if (!proj) {
      proj = {
        workspace: ws,
        repoName: repoNameOf(ws),
        source: row.meta.source,
        runs: [],
        firstRunAt: row.meta.createdAt,
        lastRunAt: row.meta.createdAt,
      };
      byWs.set(ws, proj);
    }
    proj.runs.push(row);
    proj.firstRunAt = Math.min(proj.firstRunAt, row.meta.createdAt);
    proj.lastRunAt = Math.max(proj.lastRunAt, row.meta.createdAt);
    if (!proj.source && row.meta.source) proj.source = row.meta.source;
  }
  for (const p of byWs.values()) {
    p.runs.sort((a, b) => b.meta.createdAt - a.meta.createdAt);
  }
  return Array.from(byWs.values()).sort((a, b) => b.lastRunAt - a.lastRunAt);
}

// Collapse runs for one project into per-day buckets keyed by local date.
// `dayKeys` is the window — days outside that window are ignored (those
// runs still count toward the project's activity window but don't
// render as cells).
export function bucketByDay(
  runs: SwarmRunListRow[],
  dayKeys: Set<string>,
): Map<string, SwarmRunListRow[]> {
  const out = new Map<string, SwarmRunListRow[]>();
  for (const r of runs) {
    const k = dayKeyOf(r.meta.createdAt);
    if (!dayKeys.has(k)) continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export function dominantStatus(rows: SwarmRunListRow[]): SwarmRunStatus {
  const set = new Set(rows.map((r) => r.status));
  for (const s of STATUS_PRIORITY) {
    if (set.has(s)) return s;
  }
  return 'unknown';
}
