// UI metadata for the orchestration-pattern picker in new-run-modal.
// The canonical catalog lives in `SWARM_PATTERNS.md` — keep taglines and
// availability flags in sync there when promoting a preset.

import type { SwarmPattern } from './swarm-types';

export interface PatternMeta {
  label: string;
  tagline: string;          // short description shown inside the tile
  available: boolean;       // drives disabled state + "coming soon" indicator
  accent: 'molten' | 'amber' | 'mint' | 'iris' | 'rust' | 'fog';
}

export const patternMeta: Record<SwarmPattern, PatternMeta> = {
  none: {
    label: 'none',
    tagline: 'single opencode session, native task / subtask',
    available: true,
    accent: 'molten',
  },
  blackboard: {
    label: 'blackboard',
    tagline: 'shared board, claim any unresolved todo',
    available: true,
    accent: 'amber',
  },
  'map-reduce': {
    label: 'map-reduce',
    tagline: 'split the tree, synthesize as a claimable phase',
    available: true,
    accent: 'mint',
  },
  council: {
    label: 'council',
    tagline: 'n parallel drafts, human reconciles via permissions',
    available: true,
    accent: 'iris',
  },
  'orchestrator-worker': {
    label: 'orchestrator',
    tagline: 'one orchestrator plans, n workers claim and implement',
    available: true,
    accent: 'rust',
  },
  'role-differentiated': {
    label: 'roles',
    tagline: 'n workers with pinned roles (architect, tester, …)',
    available: true,
    accent: 'iris',
  },
  'debate-judge': {
    label: 'debate',
    tagline: 'n generators propose, one judge evaluates and picks',
    available: true,
    accent: 'amber',
  },
  'critic-loop': {
    label: 'critic',
    tagline: 'worker drafts, critic reviews, worker revises (n iterations)',
    available: true,
    accent: 'mint',
  },
  'deliberate-execute': {
    label: 'deliberate→execute',
    tagline: 'council deliberation → synthesis → blackboard execution',
    available: true,
    accent: 'fog',
  },
};

// Static class-name maps so Tailwind's JIT purger keeps these utilities in
// the final bundle. Dynamic `text-${accent}` interpolation would be purged.
export const patternAccentText: Record<PatternMeta['accent'], string> = {
  molten: 'text-molten',
  amber: 'text-amber',
  mint: 'text-mint',
  iris: 'text-iris',
  rust: 'text-rust',
  fog: 'text-fog-400',
};

export const patternAccentBorder: Record<PatternMeta['accent'], string> = {
  molten: 'border-molten/40',
  amber: 'border-amber/40',
  mint: 'border-mint/40',
  iris: 'border-iris/40',
  rust: 'border-rust/40',
  fog: 'border-fog-500/40',
};
