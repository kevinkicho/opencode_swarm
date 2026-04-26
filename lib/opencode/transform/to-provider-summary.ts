// HARDENING_PLAN.md#C11 — transform.ts split.
//
// Provider rollup — per-provider (zen / go / ollama) tally of distinct
// agent count, total tokens, total cost. Drives the topbar provider
// breakdown chip and the cost-dashboard's per-provider columns.

import type { Agent, Provider, ProviderSummary } from '../../swarm-types';
import type { OpencodeMessage } from '../types';
import { derivedCost, providerOf } from './_shared';

export function toProviderSummary(
  agents: Agent[],
  messages: OpencodeMessage[],
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
    bucket.cost += derivedCost(m.info);
  }

  return Array.from(byProvider.entries()).map(([provider, b]) => ({
    provider,
    agents: b.agents.size,
    tokens: b.tokens,
    cost: b.cost,
  }));
}
