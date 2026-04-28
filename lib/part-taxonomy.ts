// Metadata for opencode canonical Part types and built-in Tool names.
// Keep display semantics here; canonical strings live in swarm-types.ts.

import type { PartType, ToolName } from './swarm-types';

export type Hue = 'molten' | 'mint' | 'iris' | 'amber' | 'fog' | 'rust';

export interface PartMeta {
  label: string;
  blurb: string;
  hue: Hue;
  // whether this part usually crosses agent lanes (delegate / return)
  // vs. lives inside a single lane as a chip
  crossLane: boolean;
}

export const partMeta: Record<PartType, PartMeta> = {
  text: {
    label: 'text',
    blurb: 'model output or user prompt',
    hue: 'fog',
    crossLane: true,
  },
  reasoning: {
    label: 'reasoning',
    blurb: 'internal model thought',
    hue: 'iris',
    crossLane: false,
  },
  tool: {
    label: 'tool',
    blurb: 'tool call + result',
    hue: 'mint',
    crossLane: false,
  },
  file: {
    label: 'file',
    blurb: 'attached or referenced file',
    hue: 'fog',
    crossLane: false,
  },
  agent: {
    label: 'agent',
    blurb: 'reference to a sub-agent',
    hue: 'molten',
    crossLane: true,
  },
  subtask: {
    label: 'subtask',
    blurb: 'delegated sub-work result',
    hue: 'molten',
    crossLane: true,
  },
  'step-start': {
    label: 'step-start',
    blurb: 'checkpoint begin',
    hue: 'fog',
    crossLane: false,
  },
  'step-finish': {
    label: 'step-finish',
    blurb: 'checkpoint end',
    hue: 'fog',
    crossLane: false,
  },
  snapshot: {
    label: 'snapshot',
    blurb: 'working-tree capture',
    hue: 'fog',
    crossLane: false,
  },
  patch: {
    label: 'patch',
    blurb: 'code diff',
    hue: 'mint',
    crossLane: false,
  },
  retry: {
    label: 'retry',
    blurb: 'retry marker',
    hue: 'amber',
    crossLane: false,
  },
  compaction: {
    label: 'compaction',
    blurb: 'context compacted',
    hue: 'fog',
    crossLane: false,
  },
};

export const partOrder: PartType[] = [
  'text',
  'reasoning',
  'tool',
  'subtask',
  'agent',
  'patch',
  'file',
  'step-start',
  'step-finish',
  'snapshot',
  'compaction',
  'retry',
];

export const partHex: Record<PartType, string> = {
  text: '#cfd6df', // fog-200
  reasoning: '#c084fc', // iris
  tool: '#5eead4', // mint
  file: '#9ba5b5', // fog-400
  agent: '#ff7a3d', // molten
  subtask: '#ff7a3d', // molten
  'step-start': '#7d8798', // fog-500
  'step-finish': '#7d8798', // fog-500
  snapshot: '#7d8798',
  patch: '#5eead4', // mint
  retry: '#fbbf24', // amber
  compaction: '#6b7380', // fog-600
};

export interface ToolMeta {
  label: string;
  blurb: string;
  hex: string;
}

// Per-tool display metadata. `task` is opencode's native A2A primitive —
// calling it spawns/resumes a sub-agent. Hex palette mirrors the existing
// fog/molten/mint/iris/amber accent system.
export const toolMeta: Record<ToolName, ToolMeta> = {
  // file & code surface
  bash: { label: 'bash', blurb: 'execute shell command', hex: '#a5f3c9' },
  read: { label: 'read', blurb: 'read file or directory', hex: '#9ba5b5' },
  write: { label: 'write', blurb: 'overwrite file', hex: '#ff7a3d' },
  edit: { label: 'edit', blurb: 'string-replace edit', hex: '#ff7a3d' },
  apply_patch: { label: 'apply_patch', blurb: 'apply unified diff', hex: '#ff7a3d' },
  // search surface
  grep: { label: 'grep', blurb: 'ripgrep file contents', hex: '#c084fc' },
  glob: { label: 'glob', blurb: 'file pattern match', hex: '#c084fc' },
  codesearch: { label: 'codesearch', blurb: 'symbol/code-aware search (LSP)', hex: '#c084fc' },
  // network surface
  webfetch: { label: 'webfetch', blurb: 'fetch + convert URL', hex: '#fbbf24' },
  websearch: { label: 'websearch', blurb: 'general web search', hex: '#fbbf24' },
  // planning & coordination
  todowrite: { label: 'todowrite', blurb: 'update todo list', hex: '#fbbf24' },
  task: { label: 'task', blurb: 'delegate to sub-agent', hex: '#ff7a3d' },
  // user-facing
  question: { label: 'question', blurb: 'ask user for clarification', hex: '#5eead4' },
  skill: { label: 'skill', blurb: 'invoke user-installed skill', hex: '#5eead4' },
};

export const toolOrder: ToolName[] = [
  'task',
  'read',
  'edit',
  'write',
  'apply_patch',
  'bash',
  'grep',
  'glob',
  'codesearch',
  'webfetch',
  'websearch',
  'todowrite',
  'question',
  'skill',
];

export const hueClass: Record<Hue, { text: string; bg: string; border: string }> = {
  molten: { text: 'text-molten', bg: 'bg-molten/10', border: 'border-molten/30' },
  mint: { text: 'text-mint', bg: 'bg-mint/10', border: 'border-mint/30' },
  iris: { text: 'text-iris', bg: 'bg-iris/10', border: 'border-iris/30' },
  amber: { text: 'text-amber', bg: 'bg-amber/10', border: 'border-amber/30' },
  fog: { text: 'text-fog-300', bg: 'bg-ink-700', border: 'border-ink-500' },
  rust: { text: 'text-rust', bg: 'bg-rust/10', border: 'border-rust/30' },
};

// Treat as lane-crossing any message whose receivers differ from the sender.
// Covers A2A delegations (task tool), subtask returns, text hand-offs, and
// permission asks (e.g. agent -> human for edit approval) uniformly.
export function isCrossLane(m: { part: PartType; toolName?: ToolName; fromAgentId: string; toAgentIds: string[] }): boolean {
  const receivers = m.toAgentIds.filter((t) => t !== m.fromAgentId);
  return receivers.length > 0;
}
