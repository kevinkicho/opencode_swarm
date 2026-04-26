// Timeline-flow constants, types + small formatters.
//
// Extracted from timeline-flow.tsx in #108. The constants drive the
// flow's positioning math; types describe the layout objects buildRow
// produces.

import type { AgentMessage } from '@/lib/swarm-types';
import { partMeta, partHex, toolMeta } from '@/lib/part-taxonomy';
import type { MessagePhase } from '@/lib/playback-context';

export const LANE_WIDTH = 168;
export const ROW_HEIGHT = 44;
export const TOP_PAD = 16;
export const NODE_WIDTH = 164;
export const NODE_HEIGHT = ROW_HEIGHT - 6;
export const DROP_SIZE = 14;
export const CARD_PIN_SIZE = 6;
export const CHIP_HEIGHT = 16;
export const CHIP_GAP = 2;
export const CHIP_TOP_PAD = 3;
export const CHIP_INSET = 6;
// Left gutter shows wall-clock HH:MM:SS per row so events can be mapped
// to real time. Width kept narrow — the time label is ~54px at 10px font.
// Parent (swarm-timeline.tsx) reads this to offset lane headers + grid.
export const TIMELINE_GUTTER_WIDTH = 56;

export function fmtWallClock(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtIso(tsMs: number): string {
  return new Date(tsMs).toISOString();
}

export function accentFor(m: AgentMessage): string {
  if (m.toolName) return toolMeta[m.toolName].hex;
  return partHex[m.part];
}

export function eventLabel(m: AgentMessage): string {
  if (m.toolName) return m.toolName;
  return partMeta[m.part].label;
}

export type Row = { a2a: AgentMessage; chips: AgentMessage[] };

export type RowLayout = {
  event: EventLayout;
  wires: WireLayout[];
  drops: DropLayout[];
  chips: ChipLayout[];
};

export type EventLayout = {
  id: string;
  msg: AgentMessage;
  cardX: number;
  accent: string;
  isIO: boolean;
  phase: MessagePhase;
  progress: number;
  fromName: string;
  toNames: string[];
  dimmed: boolean;
  focused: boolean;
};

export type WireLayout = {
  id: string;
  sx: number;
  tx: number;
  color: string;
  dashed: boolean;
  phase: MessagePhase;
  progress: number;
  dimmed: boolean;
  focused: boolean;
};

export type DropLayout = {
  id: string;
  msgId: string;
  centerX: number;
  color: string;
  phase: MessagePhase;
  progress: number;
  dimmed: boolean;
  focused: boolean;
};

export type ChipLayout = {
  id: string;
  msg: AgentMessage;
  x: number;
  color: string;
  phase: MessagePhase;
  dimmed: boolean;
  focused: boolean;
};
