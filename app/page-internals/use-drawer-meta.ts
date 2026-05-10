'use client';

import { useMemo } from 'react';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';

export interface DrawerMeta {
  title: string | undefined;
  eyebrow: string | undefined;
}

export function useDrawerMeta(
  focusedMsgId: string | null,
  selectedAgentId: string | null,
  selectedFileHeat: FileHeat | null,
  messages: readonly AgentMessage[],
  agents: readonly Agent[],
): DrawerMeta {
  return useMemo(() => {
    const title = focusedMsgId
      ? messages.find((m) => m.id === focusedMsgId)?.title
      : selectedAgentId
        ? agents.find((a) => a.id === selectedAgentId)?.name
        : selectedFileHeat
          ? selectedFileHeat.path.split(/[\\/]/).pop() || selectedFileHeat.path
          : undefined;

    const eyebrow = focusedMsgId
      ? 'message inspector'
      : selectedAgentId
        ? 'agent inspector'
        : selectedFileHeat
          ? 'file heat'
          : undefined;

    return { title, eyebrow };
  }, [focusedMsgId, selectedAgentId, selectedFileHeat, messages, agents]);
}