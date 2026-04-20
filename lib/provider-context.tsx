'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Agent, RunMeta, ProviderSummary } from './swarm-types';

type ProviderCtx = {
  agents: Agent[];
  providers: ProviderSummary[];
  run: RunMeta;
  onOpenRouting: () => void;
};

const Ctx = createContext<ProviderCtx | null>(null);

export function ProviderStatsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ProviderCtx;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProviderStats() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProviderStats must be used within ProviderStatsProvider');
  return v;
}
