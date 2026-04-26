// Heat-rail pure helpers + accent maps.
//
// Extracted from heat-rail.tsx in #108. No React deps; safe to import
// from server code (the tree builder lives in tree.ts; this file is
// the smallest building blocks).

import type { Agent } from '@/lib/swarm-types';

// Strip the run's workspace prefix from a file path so rows don't all
// start with the same 52-char `C:/Users/.../reponame/` noise. Normalize
// slashes first because opencode paths use backslashes on Windows.
export function stripWorkspace(path: string, workspace: string): string {
  const np = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const nw = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  if (nw && np.startsWith(nw + '/')) return np.slice(nw.length + 1);
  if (nw && np === nw) return '';
  return np;
}

export function splitPath(path: string): { dir: string; base: string } {
  // Normalize Windows-style backslashes so the split works cross-platform.
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return { dir: '', base: normalized };
  return { dir: normalized.slice(0, idx), base: normalized.slice(idx + 1) };
}

export function fmtAgo(ms: number): string {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

export const accentStripe: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

export const accentBadge: Record<Agent['accent'], string> = {
  molten: 'bg-molten/15 text-molten',
  mint: 'bg-mint/15 text-mint',
  iris: 'bg-iris/15 text-iris',
  amber: 'bg-amber/15 text-amber',
  fog: 'bg-fog-500/15 text-fog-400',
};
