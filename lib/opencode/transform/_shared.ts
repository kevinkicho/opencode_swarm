//
// Helpers shared across the per-transformer files. Pre-split, these all
// lived as module-private functions in lib/opencode/transform.ts. Pulling
// them here breaks the per-transformer files apart without each having to
// re-derive the same providerID/family/cost/format logic.
//
// Nothing here is exported from the lib/opencode/transform.ts barrel —
// these are purely internal helpers consumed by sibling per-transformer
// files. If a helper graduates to a public API surface, lift it here in
// _shared and add an explicit re-export from transform.ts.

import type {
  Agent,
  PartType,
  Provider,
  ToolName,
  ToolState,
} from '../../swarm-types';
import type { OpencodeMessage, OpencodePart } from '../types';
import { priceFor } from '../pricing';

export const ACCENT_ROTATION: Agent['accent'][] = ['molten', 'mint', 'iris', 'amber', 'fog'];

const KNOWN_TOOLS: ToolName[] = [
  'bash', 'read', 'write', 'edit', 'list', 'grep', 'glob',
  'webfetch', 'todowrite', 'todoread', 'task',
];

const KNOWN_PARTS: PartType[] = [
  'text', 'reasoning', 'tool', 'file', 'agent', 'subtask',
  'step-start', 'step-finish', 'snapshot', 'patch', 'retry', 'compaction',
];

// Opencode's providerID is per-message and reflects the routing gateway, not
// the model vendor. Three tiers the UI distinguishes:
//   ollama — providerID mentions 'ollama' (routed through the ollama provider
//            block the user configured in opencode.json)
//   go     — providerID carries a bundle/subscription signal ('-go', 'bundle',
//            'subscription')
//   zen    — everything else (including BYOK-shaped providerIDs like
//            'anthropic' / 'openai' / 'gemini', which still route through
//            opencode and are bucketed as zen for billing-model purposes)
// History: the zen+go-only stance was load-bearing through 2026-04-23;
// reversed 2026-04-24 — see DESIGN.md §9 history note.
export function providerOf(providerID?: string): Provider {
  if (!providerID) return 'zen';
  const p = providerID.toLowerCase();
  if (p.includes('ollama')) return 'ollama';
  if (p.includes('-go') || p.includes('bundle') || p.includes('subscription')) return 'go';
  return 'zen';
}

// Cost fallback for messages where opencode didn't populate `info.cost` (free
// tiers, old sessions, go-bundle messages). Computes per-1M pricing × tokens
// from the zen table. Returns 0 when the model isn't in the table or tokens
// are missing — better than NaN, and aligns with zero-cost free tiers.
export function derivedCost(info: OpencodeMessage['info']): number {
  if (typeof info.cost === 'number') return info.cost;
  const price = priceFor(info.modelID);
  const t = info.tokens;
  if (!price || !t) return 0;
  const input = t.input * price.input;
  const output = t.output * price.output;
  const cachedRead = t.cache.read * price.cached;
  const cachedWrite = t.cache.write * (price.write ?? price.input);
  return (input + output + cachedRead + cachedWrite) / 1_000_000;
}

export function familyOf(modelID?: string): Agent['model']['family'] {
  const m = (modelID ?? '').toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt')) return 'gpt';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('glm')) return 'glm';
  if (m.includes('nemotron')) return 'nemotron';
  if (m.includes('gemma')) return 'gemma';
  if (m.includes('mistral')) return 'mistral';
  if (m.includes('minimax')) return 'minimax';
  if (m.includes('mimo')) return 'mimo';
  return 'claude';
}

export function normalizeTool(name: string | undefined): ToolName | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return KNOWN_TOOLS.find((t) => t === n);
}

export function normalizePart(t: string): PartType {
  return (KNOWN_PARTS.find((p) => p === t) ?? 'text');
}

export function toolStateFrom(state: unknown): ToolState {
  if (state && typeof state === 'object' && 'status' in state) {
    const s = (state as { status: unknown }).status;
    if (s === 'completed' || s === 'running' || s === 'pending' || s === 'error') return s;
  }
  return 'completed';
}

// opencode's abort path sets tool state to { status: "error", metadata: { interrupted: true } }.
// Distinguish these from natural errors so the timeline can render them as abandoned, not failed.
export function isInterruptedTool(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const meta = (state as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== 'object') return false;
  return (meta as { interrupted?: unknown }).interrupted === true;
}

export function fmtTs(ms: number, anchor: number): string {
  const delta = Math.max(0, Math.floor((ms - anchor) / 1000));
  const m = Math.floor(delta / 60);
  const s = delta % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(startMs?: number, endMs?: number): string | undefined {
  if (!startMs || !endMs) return undefined;
  const ms = endMs - startMs;
  if (ms <= 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem}s`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

export function synthesizeTitle(part: OpencodePart): string {
  switch (part.type) {
    case 'text': return firstLine(part.text) || 'text';
    case 'reasoning': return firstLine(part.text) || 'reasoning';
    case 'tool': return part.tool ?? 'tool';
    case 'step-start': return 'step start';
    case 'step-finish': return `step finish · ${part.reason}`;
    case 'patch': {
      const n = part.files.length;
      return n === 1
        ? `patch · ${part.files[0]}`
        : `patch · ${n} files`;
    }
    default: return 'event';
  }
}

export function firstLine(s: string | undefined, max = 80): string {
  if (!s) return '';
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

export function bodyOf(part: OpencodePart): string | undefined {
  if (part.type === 'text' || part.type === 'reasoning') return part.text;
  if (part.type === 'tool') {
    const inp = part.input;
    if (typeof inp === 'string') return inp;
    if (inp && typeof inp === 'object') return JSON.stringify(inp, null, 2);
    return undefined;
  }
  return undefined;
}

export function previewOf(part: OpencodePart): string | undefined {
  if (part.type !== 'tool') return undefined;
  const out = part.output;
  if (typeof out === 'string') return firstLine(out, 160);
  return undefined;
}

export function isHumanAgentId(id: string | undefined): boolean {
  return !id || id === 'user' || id === 'human';
}

// Agent identity = (agent-config name, sessionID). Keying on sessionID keeps
// N parallel council members from colliding under a single roster row when
// they all share the same opencode agent-config (e.g. three "build" members).
// The last 8 chars of sessionID are enough to disambiguate at prototype scale
// — opencode IDs are long b32 suffixes, a 40-bit slice gives collision-free
// separation across any run size we care about.
//
// Single-session runs (pattern='none') still produce stable IDs — the same
// sessionID + name always rehydrates the same ag_* identifier, so URL state
// and bookmarked lookups stay consistent across polls.
export function agentIdFor(
  agentName: string | undefined,
  role: 'user' | 'assistant',
  sessionID: string,
): string {
  if (role === 'user') return 'human';
  const name = (agentName ?? 'assistant').replace(/[^a-z0-9_-]/gi, '');
  const sid = sessionID.replace(/[^a-z0-9_-]/gi, '').slice(-8);
  return `ag_${name}_${sid}`;
}
