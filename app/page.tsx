'use client';

import { useCallback, useEffect, useState } from 'react';
import { SwarmTopbar } from '@/components/swarm-topbar';
import { AgentRoster } from '@/components/agent-roster';
import { SwarmTimeline } from '@/components/swarm-timeline';
import { Inspector } from '@/components/inspector';
import { CommandPalette } from '@/components/command-palette';
import { RoutingModal } from '@/components/routing-modal';
import { CommitHistory } from '@/components/commit-history';
import { SpawnAgentModal } from '@/components/spawn-agent-modal';
import { GlossaryModal } from '@/components/glossary-modal';
import { SwarmComposer, type ComposerTarget } from '@/components/swarm-composer';
import { Drawer } from '@/components/ui/drawer';
import { Tooltip } from '@/components/ui/tooltip';
import { IconBranch } from '@/components/icons';
import { PlaybackProvider, tsToSec } from '@/lib/playback-context';
import { ProviderStatsProvider } from '@/lib/provider-context';
import {
  agents,
  agentOrder,
  messages,
  missionMeta,
  providerSummary,
} from '@/lib/swarm-data';
import type { TimelineNode } from '@/lib/types';

const paletteNodes: TimelineNode[] = messages.map((m) => ({
  id: m.id,
  kind:
    m.fromAgentId === 'human'
      ? 'user'
      : m.part === 'tool'
        ? 'tool'
        : m.part === 'reasoning'
          ? 'thinking'
          : m.part === 'subtask' || m.part === 'agent'
            ? 'agent'
            : m.part === 'step-start' || m.part === 'step-finish'
              ? 'milestone'
              : 'assistant',
  toolKind: m.toolName,
  title: m.title,
  subtitle: m.toolSubtitle ?? m.body,
  preview: m.toolPreview ?? m.body,
  timestamp: m.timestamp,
  duration: m.duration,
  status: m.status === 'pending' ? 'pending' : m.status,
  tokens: m.tokens,
}));

const missionDuration = Math.max(
  ...messages.map((m) => tsToSec(m.timestamp)),
  60
);

export default function Page() {
  const [focusedMsgId, setFocusedMsgId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);

  const focusMessage = useCallback((id: string) => {
    setFocusedMsgId((prev) => {
      if (prev === id) {
        setDrawerOpen(false);
        return null;
      }
      setSelectedAgentId(null);
      setDrawerOpen(true);
      return id;
    });
  }, []);

  const clearFocus = useCallback(() => {
    setFocusedMsgId(null);
    setSelectedAgentId(null);
    setDrawerOpen(false);
  }, []);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
    setDrawerOpen(true);
  }, []);

  const rosterSelect = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setFocusedMsgId(null);
    setSelectedAgentId(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


  const drawerTitle = focusedMsgId
    ? messages.find((m) => m.id === focusedMsgId)?.title
    : selectedAgentId
      ? agents.find((a) => a.id === selectedAgentId)?.name
      : undefined;

  const drawerEyebrow = focusedMsgId
    ? 'message inspector'
    : selectedAgentId
      ? 'agent inspector'
      : undefined;

  return (
    <PlaybackProvider missionDuration={missionDuration}>
    <ProviderStatsProvider
      value={{
        agents,
        providers: providerSummary,
        mission: missionMeta,
        onOpenRouting: () => setRoutingOpen(true),
      }}
    >
    <div className="relative h-screen w-screen flex flex-col bg-ink-900 overflow-hidden bg-noise">
      <SwarmTopbar
        mission={missionMeta}
        providers={providerSummary}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setRoutingOpen(true)}
      />

      <main className="flex-1 grid min-h-0" style={{ gridTemplateColumns: '260px 1fr' }}>
        <AgentRoster
          agents={agents}
          messages={messages}
          selectedId={selectedAgentId}
          onSelect={rosterSelect}
          onInspect={selectAgent}
          onFocus={focusMessage}
          onSpawn={() => setSpawnOpen(true)}
        />

        <SwarmTimeline
          agents={agents}
          messages={messages}
          agentOrder={agentOrder}
          focusedId={focusedMsgId}
          onFocus={focusMessage}
          onClearFocus={clearFocus}
          selectedAgentId={selectedAgentId}
          onSelectAgent={selectAgent}
        />
      </main>

      <SwarmComposer
        agents={agents}
        onSend={(target: ComposerTarget, body: string) => {
          console.info('[composer]', target, body);
        }}
      />

      <StatusRail
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenRouting={() => setRoutingOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenGlossary={() => setGlossaryOpen(true)}
      />

      <Drawer
        open={drawerOpen && (!!focusedMsgId || !!selectedAgentId)}
        onClose={closeDrawer}
        eyebrow={drawerEyebrow}
        title={drawerTitle}
        width={380}
      >
        <Inspector
          agents={agents}
          messages={messages}
          focusedMessageId={focusedMsgId}
          selectedAgentId={selectedAgentId}
          onFocus={focusMessage}
          embedded
        />
      </Drawer>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nodes={paletteNodes}
        onJump={focusMessage}
      />

      <RoutingModal open={routingOpen} onClose={() => setRoutingOpen(false)} />

      <CommitHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />

      <SpawnAgentModal open={spawnOpen} onClose={() => setSpawnOpen(false)} />

      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </div>
    </ProviderStatsProvider>
    </PlaybackProvider>
  );
}

function StatusRail({
  onOpenPalette,
  onOpenRouting,
  onOpenHistory,
  onOpenGlossary,
}: {
  onOpenPalette: () => void;
  onOpenRouting: () => void;
  onOpenHistory: () => void;
  onOpenGlossary: () => void;
}) {
  return (
    <footer className="h-7 shrink-0 hairline-t bg-ink-900 flex items-center px-4 text-[11px] font-mono text-fog-600">
      <div className="flex items-center gap-3">
        <Tooltip content="live swarm websocket connected" side="top">
          <span className="flex items-center gap-1.5 cursor-default">
            <span className="w-1.5 h-1.5 rounded-full bg-mint" />
            <span className="text-fog-400">swarm live</span>
          </span>
        </Tooltip>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip
          side="top"
          content={
            <span className="font-mono text-[11px] text-fog-200">
              open palette{' '}
              <span className="text-fog-500">⌘K / Ctrl+K</span>
            </span>
          }
        >
          <button
            onClick={onOpenPalette}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">palette</span>
          </button>
        </Tooltip>

        <Tooltip content="routing rules" side="top">
          <button
            onClick={onOpenRouting}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">routing</span>
          </button>
        </Tooltip>

        <Tooltip
          side="top"
          wide
          content={
            <div className="space-y-0.5">
              <div className="font-mono text-[11px] text-fog-200">opencode vocabulary</div>
              <div className="font-mono text-[10.5px] text-fog-600">
                canonical part, tool, and event names
              </div>
            </div>
          }
        >
          <button
            onClick={onOpenGlossary}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <span className="text-fog-700">glossary</span>
          </button>
        </Tooltip>

        <Tooltip content="branch history" side="top">
          <button
            onClick={onOpenHistory}
            className="flex items-center gap-1 h-5 px-1.5 rounded hover:bg-ink-800 transition text-fog-600 hover:text-fog-200"
          >
            <IconBranch size={10} className="text-fog-500" />
            <span className="text-fog-700">history</span>
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
