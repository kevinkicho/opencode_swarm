'use client';

import clsx from 'clsx';
import type { Agent, AgentMessage } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';
import {
  AgentInspector,
  EmptyState,
  FileHeatInspector,
  MessageInspector,
} from './inspector/sub-components';

// Inspector — drawer panel that surfaces details for whatever is focused
// (a message, an agent, or a heat-rail file selection). The four panels
// (MessageInspector, AgentInspector, FileHeatInspector, EmptyState) live
// in inspector/sub-components.tsx; this file owns the dispatch.
//
// Decomposed in #108.

export function Inspector({
  agents,
  messages,
  focusedMessageId,
  selectedAgentId,
  selectedFileHeat,
  workspace,
  onFocus,
  embedded,
}: {
  agents: Agent[];
  messages: AgentMessage[];
  focusedMessageId: string | null;
  selectedAgentId: string | null;
  // Selected row on the heat rail — opens the file-inspector panel.
  // Takes priority only when no message / agent is focused (so a mid-run
  // timeline click doesn't get stomped by a lingering heat selection).
  selectedFileHeat: FileHeat | null;
  // Workspace root for stripping the prefix from displayed paths. Same
  // source as the heat rail uses.
  workspace: string;
  onFocus: (id: string) => void;
  embedded?: boolean;
}) {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const msg = messages.find((m) => m.id === focusedMessageId);
  const selectedAgent = selectedAgentId ? agentMap.get(selectedAgentId) : undefined;

  const body = (
    <div className={clsx('space-y-3', embedded ? 'p-4' : 'p-3')}>
      {msg ? (
        <MessageInspector msg={msg} agents={agentMap} messages={messages} onFocus={onFocus} />
      ) : selectedAgent ? (
        <AgentInspector
          agent={selectedAgent}
          messages={messages}
          onFocus={onFocus}
          workspace={workspace}
        />
      ) : selectedFileHeat ? (
        <FileHeatInspector
          heat={selectedFileHeat}
          workspace={workspace}
          agents={agents}
        />
      ) : (
        <EmptyState />
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <aside className="w-[340px] shrink-0 hairline-l bg-ink-850 flex flex-col min-h-0">
      <div className="h-10 hairline-b px-4 flex items-center gap-3 bg-ink-850/80 backdrop-blur">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          inspector
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">{body}</div>
    </aside>
  );
}
