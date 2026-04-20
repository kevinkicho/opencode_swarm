'use client';

import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import type { AgentMessage, PartType, ToolName } from './swarm-types';

export function tsToSec(ts: string): number {
  const [mm, ss] = ts.split(':').map((n) => parseInt(n, 10));
  return (mm || 0) * 60 + (ss || 0);
}

export function streamingWindow(msg: AgentMessage): number {
  const tokens = msg.tokens ?? 500;
  if (msg.part === 'tool') {
    return Math.min(1.2, Math.max(0.3, tokens / 4000));
  }
  return Math.min(4, Math.max(0.8, tokens / 1400));
}

export function messageArrivesAt(msg: AgentMessage): number {
  return tsToSec(msg.timestamp);
}

export function messageStartsAt(msg: AgentMessage): number {
  return Math.max(0, messageArrivesAt(msg) - streamingWindow(msg));
}

export type MessagePhase = 'hidden' | 'streaming' | 'complete';

export function phaseFor(msg: AgentMessage, clockSec: number): MessagePhase {
  const arrive = messageArrivesAt(msg);
  const start = messageStartsAt(msg);
  if (clockSec < start) return 'hidden';
  if (clockSec < arrive) return 'streaming';
  return 'complete';
}

export function streamProgress(msg: AgentMessage, clockSec: number): number {
  const arrive = messageArrivesAt(msg);
  const start = messageStartsAt(msg);
  const span = arrive - start;
  if (span <= 0) return 1;
  const t = (clockSec - start) / span;
  return Math.min(1, Math.max(0, t));
}

export interface LaneStream {
  msgId: string;
  part: PartType;
  toolName?: ToolName;
  rate: number;
  progress: number;
}

export interface LaneThroughput {
  inRate: number;
  outRate: number;
  activeIn: LaneStream[];
  activeOut: LaneStream[];
}

export function laneThroughput(
  agentId: string,
  messages: AgentMessage[],
  clockSec: number
): LaneThroughput {
  let inRate = 0;
  let outRate = 0;
  const activeIn: LaneStream[] = [];
  const activeOut: LaneStream[] = [];

  for (const m of messages) {
    if (phaseFor(m, clockSec) !== 'streaming') continue;
    const tokens = m.tokens ?? 0;
    if (tokens <= 0) continue;
    const win = streamingWindow(m);
    const rate = tokens / Math.max(0.01, win);
    const progress = streamProgress(m, clockSec);

    if (m.fromAgentId === agentId) {
      outRate += rate;
      activeOut.push({ msgId: m.id, part: m.part, toolName: m.toolName, rate, progress });
    }
    if (m.toAgentIds?.includes(agentId)) {
      inRate += rate;
      activeIn.push({ msgId: m.id, part: m.part, toolName: m.toolName, rate, progress });
    }
  }
  return { inRate, outRate, activeIn, activeOut };
}

export function formatRate(tokPerSec: number): string {
  if (tokPerSec <= 0) return '-';
  if (tokPerSec >= 1000) return `${(tokPerSec / 1000).toFixed(1)}k`;
  if (tokPerSec >= 100) return `${Math.round(tokPerSec)}`;
  return tokPerSec.toFixed(0);
}

interface PlaybackStore {
  clockSec: number;
  playing: boolean;
  speed: number;
  missionDuration: number;
  setClockSec: (v: number) => void;
  setPlaying: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setMissionDuration: (v: number) => void;
  restart: () => void;
}

const usePlaybackStore = create<PlaybackStore>((set) => ({
  clockSec: 0,
  playing: false,
  speed: 1,
  missionDuration: 0,
  setClockSec: (v) => set({ clockSec: v }),
  setPlaying: (v) => set({ playing: v }),
  setSpeed: (v) => set({ speed: v }),
  setMissionDuration: (v) => set({ missionDuration: v }),
  restart: () => set({ clockSec: 0, playing: true }),
}));

export function usePlayback() {
  return usePlaybackStore();
}

export function PlaybackProvider({
  children,
  missionDuration,
  initialSec,
}: {
  children: ReactNode;
  missionDuration: number;
  initialSec?: number;
}) {
  const playing = usePlaybackStore((s) => s.playing);
  const speed = usePlaybackStore((s) => s.speed);

  useEffect(() => {
    usePlaybackStore.setState({
      missionDuration,
      clockSec: initialSec ?? missionDuration,
    });
  }, [missionDuration, initialSec]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const { clockSec, missionDuration: md } = usePlaybackStore.getState();
      const next = clockSec + dt * speed;
      if (next >= md) {
        usePlaybackStore.setState({ clockSec: md, playing: false });
        return;
      }
      usePlaybackStore.setState({ clockSec: next });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  return <>{children}</>;
}
