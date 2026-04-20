import type { Agent, AgentMessage } from './swarm-types';

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
