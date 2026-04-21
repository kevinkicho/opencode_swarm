// Maps live opencode session data into the prototype's mock-data shapes
// (Agent[] / AgentMessage[] / RunMeta / ProviderSummary[]) so the existing
// timeline, roster, and inspector can render it with zero component changes.

import type {
  Agent,
  AgentMessage,
  RunMeta,
  ProviderSummary,
  Provider,
  PartType,
  ToolName,
  ToolState,
} from '../swarm-types';
import type {
  OpencodeMessage,
  OpencodePart,
  OpencodeSession,
  OpencodeTokenUsage,
} from './types';

const ACCENT_ROTATION: Agent['accent'][] = ['molten', 'mint', 'iris', 'amber', 'fog'];
const KNOWN_TOOLS: ToolName[] = [
  'bash', 'read', 'write', 'edit', 'list', 'grep', 'glob',
  'webfetch', 'todowrite', 'todoread', 'task',
];
const KNOWN_PARTS: PartType[] = [
  'text', 'reasoning', 'tool', 'file', 'agent', 'subtask',
  'step-start', 'step-finish', 'snapshot', 'patch', 'retry', 'compaction',
];

function providerOf(providerID?: string): Provider {
  if (!providerID) return 'zen';
  const p = providerID.toLowerCase();
  if (p.includes('anthropic') || p.includes('claude') || p.includes('openai') || p.includes('gpt')) return 'zen';
  return 'go';
}

function familyOf(modelID?: string): Agent['model']['family'] {
  const m = (modelID ?? '').toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt')) return 'gpt';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('glm')) return 'glm';
  return 'claude';
}

function normalizeTool(name: string | undefined): ToolName | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return KNOWN_TOOLS.find((t) => t === n);
}

function normalizePart(t: string): PartType {
  return (KNOWN_PARTS.find((p) => p === t) ?? 'text');
}

function toolStateFrom(state: unknown): ToolState {
  if (state && typeof state === 'object' && 'status' in state) {
    const s = (state as { status: unknown }).status;
    if (s === 'completed' || s === 'running' || s === 'pending' || s === 'error') return s;
  }
  return 'completed';
}

function fmtTs(ms: number, anchor: number): string {
  const delta = Math.max(0, Math.floor((ms - anchor) / 1000));
  const m = Math.floor(delta / 60);
  const s = delta % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(startMs?: number, endMs?: number): string | undefined {
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

function synthesizeTitle(part: OpencodePart): string {
  switch (part.type) {
    case 'text': return firstLine(part.text) || 'text';
    case 'reasoning': return firstLine(part.text) || 'reasoning';
    case 'tool': return part.tool ?? 'tool';
    case 'step-start': return 'step start';
    case 'step-finish': return `step finish · ${part.reason}`;
    default: return 'event';
  }
}

function firstLine(s: string | undefined, max = 80): string {
  if (!s) return '';
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function bodyOf(part: OpencodePart): string | undefined {
  if (part.type === 'text' || part.type === 'reasoning') return part.text;
  if (part.type === 'tool') {
    const inp = part.input;
    if (typeof inp === 'string') return inp;
    if (inp && typeof inp === 'object') return JSON.stringify(inp, null, 2);
    return undefined;
  }
  return undefined;
}

function previewOf(part: OpencodePart): string | undefined {
  if (part.type !== 'tool') return undefined;
  const out = part.output;
  if (typeof out === 'string') return firstLine(out, 160);
  return undefined;
}

function isHumanAgentId(id: string | undefined): boolean {
  return !id || id === 'user' || id === 'human';
}

function agentIdFor(agentName: string | undefined, role: 'user' | 'assistant'): string {
  if (role === 'user') return 'human';
  return `ag_${(agentName ?? 'assistant').replace(/[^a-z0-9_-]/gi, '')}`;
}

export function toAgents(messages: OpencodeMessage[]): {
  agents: Agent[];
  agentOrder: string[];
} {
  const byId = new Map<string, Agent>();
  const order: string[] = [];

  messages.forEach((m, idx) => {
    if (m.info.role !== 'assistant') return;
    const id = agentIdFor(m.info.agent, 'assistant');
    const existing = byId.get(id);
    const tokens = m.info.tokens?.total ?? 0;
    const cost = m.info.cost ?? 0;

    if (!existing) {
      order.push(id);
      byId.set(id, {
        id,
        name: m.info.agent ?? 'assistant',
        model: {
          id: m.info.modelID ?? 'unknown',
          label: m.info.modelID?.split('/').pop() ?? 'unknown',
          provider: providerOf(m.info.providerID),
          family: familyOf(m.info.modelID),
        },
        status: 'idle',
        focus: m.info.mode,
        tokensUsed: tokens,
        tokensBudget: 80_000,
        costUsed: cost,
        messagesSent: 1,
        messagesRecv: 0,
        accent: ACCENT_ROTATION[order.length % ACCENT_ROTATION.length],
        glyph: (m.info.agent ?? 'A').charAt(0).toUpperCase(),
        tools: [],
      });
    } else {
      existing.tokensUsed += tokens;
      existing.costUsed += cost;
      existing.messagesSent += 1;
    }

    // infer tools used
    const agent = byId.get(id)!;
    for (const part of m.parts) {
      if (part.type === 'tool') {
        const t = normalizeTool(part.tool);
        if (t && !agent.tools.includes(t)) agent.tools.push(t);
      }
    }

    // last assistant message marks the "active" agent
    if (idx === messages.length - 1) agent.status = 'thinking';
  });

  return { agents: Array.from(byId.values()), agentOrder: order };
}

export function toMessages(
  messages: OpencodeMessage[]
): AgentMessage[] {
  if (messages.length === 0) return [];
  const anchor = messages[0].info.time.created;
  const out: AgentMessage[] = [];

  // Track most recent assistant agent so user messages route to it
  let lastAssistant: string | undefined;
  for (const m of messages) {
    if (m.info.role === 'assistant') {
      lastAssistant = agentIdFor(m.info.agent, 'assistant');
      break;
    }
  }

  for (const m of messages) {
    const role = m.info.role;
    const fromAgentId = role === 'user' ? 'human' : agentIdFor(m.info.agent, 'assistant');
    if (role === 'assistant') lastAssistant = fromAgentId;
    const toAgentIds =
      role === 'user'
        ? lastAssistant
          ? [lastAssistant]
          : ['human']
        : ['human'];

    for (const part of m.parts) {
      const tMs = (part as { time?: { start: number; end?: number } }).time?.start ?? m.info.time.created;
      const partType = normalizePart(part.type);
      const toolName = part.type === 'tool' ? normalizeTool(part.tool) : undefined;
      const toolState = part.type === 'tool' ? toolStateFrom(part.state) : undefined;
      const status: AgentMessage['status'] =
        toolState === 'error' ? 'error'
        : toolState === 'pending' || toolState === 'running' ? 'running'
        : 'complete';

      const partTokens: number | undefined =
        part.type === 'step-finish'
          ? (part.tokens as OpencodeTokenUsage | undefined)?.total
          : undefined;

      out.push({
        id: part.id,
        fromAgentId: isHumanAgentId(fromAgentId) ? 'human' : fromAgentId,
        toAgentIds,
        part: partType,
        toolName,
        toolState,
        title: synthesizeTitle(part),
        body: bodyOf(part),
        toolPreview: previewOf(part),
        timestamp: fmtTs(tMs, anchor),
        duration: fmtDuration(
          (part as { time?: { start: number; end?: number } }).time?.start,
          (part as { time?: { start: number; end?: number } }).time?.end
        ),
        tokens: partTokens,
        status,
        threadId: m.info.id,
      });
    }
  }

  return out;
}

export function toRunMeta(
  session: OpencodeSession | null,
  messages: OpencodeMessage[]
): RunMeta {
  let totalTokens = 0;
  let totalCost = 0;
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    totalTokens += m.info.tokens?.total ?? 0;
    totalCost += m.info.cost ?? 0;
  }

  const startedMs = session?.time.created ?? messages[0]?.info.time.created ?? Date.now();
  const lastMs =
    messages[messages.length - 1]?.info.time.completed ??
    messages[messages.length - 1]?.info.time.created ??
    Date.now();
  const elapsedSec = Math.max(0, Math.floor((lastMs - startedMs) / 1000));
  const elapsed =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : elapsedSec < 3600
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  return {
    id: session?.id ?? 'run_live',
    title: session?.title ?? 'live session',
    status: 'active',
    started: new Date(startedMs).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    elapsed,
    totalTokens,
    totalCost,
    budgetCap: 5.0,
    goTier: { window: '5h', used: 0, cap: 12.0 },
    cwd: session?.directory ?? '',
  };
}

export function toProviderSummary(
  agents: Agent[],
  messages: OpencodeMessage[]
): ProviderSummary[] {
  const byProvider = new Map<Provider, { agents: Set<string>; tokens: number; cost: number }>();

  for (const a of agents) {
    if (!byProvider.has(a.model.provider)) {
      byProvider.set(a.model.provider, { agents: new Set(), tokens: 0, cost: 0 });
    }
    byProvider.get(a.model.provider)!.agents.add(a.id);
  }

  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    const provider = providerOf(m.info.providerID);
    if (!byProvider.has(provider)) {
      byProvider.set(provider, { agents: new Set(), tokens: 0, cost: 0 });
    }
    const bucket = byProvider.get(provider)!;
    bucket.tokens += m.info.tokens?.total ?? 0;
    bucket.cost += m.info.cost ?? 0;
  }

  return Array.from(byProvider.entries()).map(([provider, b]) => ({
    provider,
    agents: b.agents.size,
    tokens: b.tokens,
    cost: b.cost,
  }));
}
