// buildRow — pure layout calculator. Takes a Row + run state and
// returns the positioned EventLayout / WireLayout / DropLayout /
// ChipLayout that the SVG + DOM render layers consume.
//
// Extracted from timeline-flow.tsx in #108. Pure; does no I/O. The
// dimming math (eventDimmed / edgeDimmed / chip dimmed) is the
// trickiest part — it derives from the focused-message vs.
// selected-agent state so the right surfaces fade out without
// breaking interactivity.

import type { Agent } from '@/lib/swarm-types';
import { isCrossLane } from '@/lib/part-taxonomy';
import { phaseFor, streamProgress } from '@/lib/playback-context';
import {
  CHIP_INSET,
  LANE_WIDTH,
  NODE_WIDTH,
  TIMELINE_GUTTER_WIDTH,
  accentFor,
  type ChipLayout,
  type DropLayout,
  type EventLayout,
  type Row,
  type RowLayout,
  type WireLayout,
} from './types';

export function buildRow(
  row: Row,
  agentIndex: Map<string, number>,
  agentMap: Map<string, Agent>,
  clockSec: number,
  focusedId: string | null,
  selectedAgentId: string | null,
): RowLayout {
  const m = row.a2a;
  const fromIdx = m.fromAgentId === 'human' ? 0 : agentIndex.get(m.fromAgentId) ?? 0;
  const fromCenterX = TIMELINE_GUTTER_WIDTH + fromIdx * LANE_WIDTH + LANE_WIDTH / 2;
  const cardX = fromCenterX - NODE_WIDTH / 2;
  const phase = phaseFor(m, clockSec);
  const progress = phase === 'streaming' ? streamProgress(m, clockSec) : 1;
  const fromName =
    m.fromAgentId === 'human' ? 'human' : agentMap.get(m.fromAgentId)?.name ?? m.fromAgentId;
  const toNames = m.toAgentIds.map((tid) =>
    tid === 'human' ? 'human' : agentMap.get(tid)?.name ?? tid,
  );
  const accent = accentFor(m);
  const isIO = isCrossLane(m);

  const msgFocused = focusedId === m.id;
  const otherFocused = focusedId != null && focusedId !== m.id;
  const msgInvolvesAgent =
    !selectedAgentId ||
    m.fromAgentId === selectedAgentId ||
    m.toAgentIds.includes(selectedAgentId);
  const eventDimmed = !msgFocused && (otherFocused || !msgInvolvesAgent);

  const event: EventLayout = {
    id: m.id,
    msg: m,
    cardX,
    accent,
    isIO,
    phase,
    progress,
    fromName,
    toNames,
    dimmed: eventDimmed,
    focused: msgFocused,
  };

  const wires: WireLayout[] = [];
  const drops: DropLayout[] = [];

  if (isIO) {
    const receivers = m.toAgentIds.filter((tid) => tid !== m.fromAgentId);
    const dashed = receivers.length > 1;

    receivers.forEach((tid, ti) => {
      const toIdx = tid === 'human' ? 0 : agentIndex.get(tid);
      if (toIdx === undefined) return;
      const toLaneX = TIMELINE_GUTTER_WIDTH + toIdx * LANE_WIDTH + LANE_WIDTH / 2;
      const goesRight = toLaneX > fromCenterX;
      const sx = goesRight ? fromCenterX + NODE_WIDTH / 2 : fromCenterX - NODE_WIDTH / 2;
      const edgeInvolvesAgent =
        !selectedAgentId || m.fromAgentId === selectedAgentId || tid === selectedAgentId;
      const edgeDimmed = !msgFocused && (otherFocused || !edgeInvolvesAgent);

      wires.push({
        id: `${m.id}__edge__${tid}__${ti}`,
        sx,
        tx: toLaneX,
        color: accent,
        dashed,
        phase,
        progress,
        dimmed: edgeDimmed,
        focused: msgFocused,
      });

      drops.push({
        id: `${m.id}__drop__${tid}__${ti}`,
        msgId: m.id,
        centerX: toLaneX,
        color: accent,
        phase,
        progress,
        dimmed: edgeDimmed,
        focused: msgFocused,
      });
    });
  }

  const chips: ChipLayout[] = row.chips.map((cm) => {
    const cIdx = cm.fromAgentId === 'human' ? 0 : agentIndex.get(cm.fromAgentId) ?? 0;
    const laneLeft = TIMELINE_GUTTER_WIDTH + cIdx * LANE_WIDTH + CHIP_INSET;
    const cPhase = phaseFor(cm, clockSec);
    const chipFocused = focusedId === cm.id;
    const otherFocusedForChip = focusedId != null && focusedId !== cm.id;
    const chipInvolvesAgent = !selectedAgentId || cm.fromAgentId === selectedAgentId;
    return {
      id: cm.id,
      msg: cm,
      x: laneLeft,
      color: accentFor(cm),
      phase: cPhase,
      dimmed: !chipFocused && (otherFocusedForChip || !chipInvolvesAgent),
      focused: chipFocused,
    };
  });

  return { event, wires, drops, chips };
}
