import type { Agent, AgentMessage } from './swarm-types';

// Token throughput samples per agent. Each sample = tokens produced in
// a BUCKET_MS window. Used by the roster sparkline to visualize how
// hard each agent is working over the last WINDOW_MS. Computed from
// AgentMessage.tokens (per-message count) + AgentMessage.tsMs (epoch ms).
export const THROUGHPUT_WINDOW_MS = 30_000; // 30s lookback
const BUCKET_MS = 5_000; // 5s buckets → 6 samples in 30s

export interface ThroughputSample {
  ts: number;      // bucket start epoch ms
  tokens: number;  // token count in this bucket
}

export function computeThroughputPerAgent(
  agents: Agent[],
  messages: AgentMessage[],
): Map<string, ThroughputSample[]> {
  const now = Date.now();
  const windowStart = now - THROUGHPUT_WINDOW_MS;
  const byAgent = new Map<string, ThroughputSample[]>();

  // Pre-allocate 6 empty buckets per agent
  for (const a of agents) {
    const buckets: ThroughputSample[] = [];
    for (let i = 0; i < THROUGHPUT_WINDOW_MS / BUCKET_MS; i++) {
      buckets.push({ ts: windowStart + i * BUCKET_MS, tokens: 0 });
    }
    byAgent.set(a.id, buckets);
  }

  // Accumulate per-message tokens into buckets
  for (const m of messages) {
    if (m.tsMs == null || m.tokens == null) continue;
    if (m.fromAgentId === 'human') continue;
    if (m.tsMs < windowStart) continue;
    const buckets = byAgent.get(m.fromAgentId);
    if (!buckets) continue;
    const bucketIdx = Math.min(
      Math.floor((m.tsMs - windowStart) / BUCKET_MS),
      buckets.length - 1,
    );
    buckets[bucketIdx].tokens += m.tokens;
  }

  return byAgent;
}

// Compute per-agent elapsed time (ms) from first to last assistant message.
// Returns a map of agentId → elapsedMs. Agents with no messages are omitted.
// Used by the roster to show "3m 12s" elapsed in each row.
export function computeElapsedPerAgent(
  agents: Agent[],
  messages: AgentMessage[],
): Map<string, number> {
  const map = new Map<string, { first: number; last: number }>();
  for (const m of messages) {
    if (m.tsMs == null) continue;
    if (m.fromAgentId === 'human') continue;
    const agent = agents.find((a) => a.id === m.fromAgentId);
    if (!agent) continue;
    const existing = map.get(agent.id);
    if (existing) {
      if (m.tsMs < existing.first) existing.first = m.tsMs;
      if (m.tsMs > existing.last) existing.last = m.tsMs;
    } else {
      map.set(agent.id, { first: m.tsMs, last: m.tsMs });
    }
  }
  const result = new Map<string, number>();
  for (const [id, { first, last }] of map) {
    result.set(id, last - first);
  }
  return result;
}

export type Attention = {
  pending: AgentMessage[];
  errors: AgentMessage[];
  retries: AgentMessage[];
};

export function computeAttention(agent: Agent, messages: AgentMessage[]): Attention {
  const pending: AgentMessage[] = [];
  const errors: AgentMessage[] = [];
  const retries: AgentMessage[] = [];
  for (const m of messages) {
    const involves = m.fromAgentId === agent.id || m.toAgentIds.includes(agent.id);
    if (!involves) continue;
    if (m.permission?.state === 'asked' && m.status === 'pending') pending.push(m);
    if (m.status === 'error' && m.fromAgentId === agent.id) errors.push(m);
    if (m.part === 'retry' && m.fromAgentId === agent.id) retries.push(m);
  }
  return { pending, errors, retries };
}

export type StatusCircle = {
  dot: string;
  animation?: string;
};

// Maps agent status + attention overrides to a circle color + pulse animation.
// Palette is commonsense: green=go, orange=busy, yellow=caution, blue=done,
// red=stuck. Override priority: permission (yellow urgent) > retry (red double).
export function statusCircle(agent: Agent, attention: Attention): StatusCircle {
  if (attention.pending.length > 0) {
    return { dot: 'bg-amber', animation: 'animate-urgent-pulse' };
  }
  if (attention.retries.length > 0) {
    return { dot: 'bg-rust', animation: 'animate-retry-pulse' };
  }
  switch (agent.status) {
    case 'working':
    case 'thinking':
      return { dot: 'bg-molten', animation: 'animate-pulse-ring' };
    case 'done':
      return { dot: 'bg-sky' };
    case 'error':
      return { dot: 'bg-rust' };
    case 'waiting':
      return { dot: 'bg-amber' };
    case 'paused':
      return { dot: 'bg-fog-600' };
    case 'idle':
      return { dot: 'bg-mint' };
    default:
      return { dot: 'bg-fog-700' };
  }
}
