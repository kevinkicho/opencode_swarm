// Pin the timeline drop-on-lane routing contract.
//
// The user-visible behavior: A2A messages (e.g. an agent posting a
// `task` tool call to delegate work) draw a wire that ends on the
// receiver's lane column, NOT on the receiver card. The drop marker
// (the small caret/triangle the wire terminates in) lands at the lane
// center too. This was a deliberate design choice (see project memory
// `timeline-drop-on-lane`) — easy to silently regress if someone
// "fixes" wire endpoints to land on cards.
//
// buildRow is pure layout math, so we can assert positions exactly
// without rendering anything. Lane positions follow the standard
// formula: TIMELINE_GUTTER_WIDTH + agentIndex * LANE_WIDTH + LANE_WIDTH/2.

import { describe, it, expect } from 'vitest';
import { buildRow } from '../build-row';
import {
  LANE_WIDTH,
  TIMELINE_GUTTER_WIDTH,
  type Row,
} from '../types';
import type { Agent, AgentMessage } from '@/lib/swarm-types';

function laneCenterX(agentIdx: number): number {
  return TIMELINE_GUTTER_WIDTH + agentIdx * LANE_WIDTH + LANE_WIDTH / 2;
}

function makeAgent(id: string, accent: Agent['accent'] = 'mint'): Agent {
  return {
    id,
    sessionID: `ses_${id}`,
    name: id,
    model: { id: 'm', label: 'm', provider: 'go', family: 'glm' },
    status: 'idle',
    tokensUsed: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensBudget: 0,
    costUsed: 0,
    messagesSent: 0,
    messagesRecv: 0,
    accent,
    glyph: '·',
    tools: [],
  };
}

function makeMessage(
  partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'fromAgentId' | 'toAgentIds'>,
): AgentMessage {
  return {
    part: 'text',
    title: 'msg',
    timestamp: '00:00',
    status: 'complete',
    ...partial,
  };
}

const agents = [makeAgent('alice'), makeAgent('bob'), makeAgent('carol')];
const agentMap = new Map(agents.map((a) => [a.id, a]));
const agentIndex = new Map(agents.map((a, i) => [a.id, i]));

const baseRow = (msg: AgentMessage, chips: AgentMessage[] = []): Row => ({
  a2a: msg,
  chips,
});

describe('buildRow — drop-on-lane routing', () => {
  it('A2A message: wire endpoint x lands on the receiver lane center', () => {
    const msg = makeMessage({
      id: 'm1',
      fromAgentId: 'alice',
      toAgentIds: ['bob'],
      part: 'text',
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    expect(layout.event.isIO).toBe(true);
    expect(layout.wires).toHaveLength(1);
    // bob is at index 1 — wire's tx must land on bob's lane center,
    // not on a card position. This is the load-bearing assertion.
    expect(layout.wires[0].tx).toBe(laneCenterX(1));
  });

  it('drop marker lands on the receiver lane center too', () => {
    const msg = makeMessage({
      id: 'm2',
      fromAgentId: 'alice',
      toAgentIds: ['carol'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    expect(layout.drops).toHaveLength(1);
    expect(layout.drops[0].centerX).toBe(laneCenterX(2));
  });

  it('multiple receivers → multiple wires, all dashed', () => {
    const msg = makeMessage({
      id: 'm3',
      fromAgentId: 'alice',
      toAgentIds: ['bob', 'carol'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    expect(layout.wires).toHaveLength(2);
    expect(layout.wires.every((w) => w.dashed)).toBe(true);
    // One wire ends on bob, one on carol
    const targets = layout.wires.map((w) => w.tx).sort((a, b) => a - b);
    expect(targets).toEqual([laneCenterX(1), laneCenterX(2)]);
  });

  it('single receiver wire is solid (not dashed)', () => {
    const msg = makeMessage({
      id: 'm4',
      fromAgentId: 'alice',
      toAgentIds: ['bob'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    expect(layout.wires[0].dashed).toBe(false);
  });

  it('non-A2A (self-message) produces no wires or drops', () => {
    // A `text` part where toAgentIds == [fromAgentId] is the agent
    // talking to themselves — not a lane-crossing event.
    const msg = makeMessage({
      id: 'm5',
      fromAgentId: 'alice',
      toAgentIds: ['alice'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    expect(layout.event.isIO).toBe(false);
    expect(layout.wires).toEqual([]);
    expect(layout.drops).toEqual([]);
  });

  it('receiver not in roster is silently dropped (no spurious wire)', () => {
    // Mid-flight a message can reference an agent id we no longer have
    // in the roster (e.g. retro view of a roster that has since
    // shrunk). Drawing a wire to a missing index would crash the SVG;
    // skipping it produces a clean partial render.
    const msg = makeMessage({
      id: 'm6',
      fromAgentId: 'alice',
      toAgentIds: ['ghost'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    expect(layout.wires).toEqual([]);
    expect(layout.drops).toEqual([]);
  });
});

describe('buildRow — wire direction (sx)', () => {
  it('wire from lane 0 to lane 2 starts on right edge of source card', () => {
    const msg = makeMessage({
      id: 'm7',
      fromAgentId: 'alice',
      toAgentIds: ['carol'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    // carol is to the right of alice → wire exits the card's right edge
    const aliceCenter = laneCenterX(0);
    expect(layout.wires[0].sx).toBeGreaterThan(aliceCenter);
  });

  it('wire from lane 2 to lane 0 starts on left edge of source card', () => {
    const msg = makeMessage({
      id: 'm8',
      fromAgentId: 'carol',
      toAgentIds: ['alice'],
    });
    const layout = buildRow(baseRow(msg), agentIndex, agentMap, 9999, null, null);
    // alice is left of carol → wire exits left edge
    const carolCenter = laneCenterX(2);
    expect(layout.wires[0].sx).toBeLessThan(carolCenter);
  });
});

describe('buildRow — chip positioning', () => {
  it('chips dock under their owner lane (not the A2A row sender)', () => {
    // Tool/internal events render as compact chips beneath the A2A
    // row. Each chip docks under its own owner lane — even when the
    // A2A row's sender is a different agent.
    const a2a = makeMessage({
      id: 'a2a',
      fromAgentId: 'alice',
      toAgentIds: ['carol'],
    });
    const bobChip = makeMessage({
      id: 'chip',
      fromAgentId: 'bob',
      toAgentIds: ['bob'],
      part: 'tool',
      toolName: 'read',
    });
    const layout = buildRow(
      baseRow(a2a, [bobChip]),
      agentIndex,
      agentMap,
      9999,
      null,
      null,
    );
    expect(layout.chips).toHaveLength(1);
    // Bob is at index 1 — chip x sits at the start of bob's lane (not
    // alice's, even though the A2A row sender is alice).
    const bobLaneLeft = TIMELINE_GUTTER_WIDTH + 1 * LANE_WIDTH;
    expect(layout.chips[0].x).toBeGreaterThanOrEqual(bobLaneLeft);
    expect(layout.chips[0].x).toBeLessThan(bobLaneLeft + LANE_WIDTH);
  });
});

describe('buildRow — focus dimming', () => {
  it('focusing a different message dims this row event + wires', () => {
    const msg = makeMessage({
      id: 'm-self',
      fromAgentId: 'alice',
      toAgentIds: ['bob'],
    });
    const layout = buildRow(
      baseRow(msg),
      agentIndex,
      agentMap,
      9999,
      'm-other',
      null,
    );
    expect(layout.event.dimmed).toBe(true);
    expect(layout.wires[0].dimmed).toBe(true);
  });

  it('focusing this message keeps it bright + flags focused=true', () => {
    const msg = makeMessage({
      id: 'm-self',
      fromAgentId: 'alice',
      toAgentIds: ['bob'],
    });
    const layout = buildRow(
      baseRow(msg),
      agentIndex,
      agentMap,
      9999,
      'm-self',
      null,
    );
    expect(layout.event.dimmed).toBe(false);
    expect(layout.event.focused).toBe(true);
    expect(layout.wires[0].focused).toBe(true);
  });

  it('selecting an agent dims rows that don\'t involve them', () => {
    const msg = makeMessage({
      id: 'm-bob-carol',
      fromAgentId: 'bob',
      toAgentIds: ['carol'],
    });
    // Selecting alice — this row is bob → carol, alice is not involved
    const layout = buildRow(
      baseRow(msg),
      agentIndex,
      agentMap,
      9999,
      null,
      'alice',
    );
    expect(layout.event.dimmed).toBe(true);
  });

  it('selecting an agent keeps rows that involve them bright', () => {
    const msg = makeMessage({
      id: 'm-alice-bob',
      fromAgentId: 'alice',
      toAgentIds: ['bob'],
    });
    const layout = buildRow(
      baseRow(msg),
      agentIndex,
      agentMap,
      9999,
      null,
      'alice',
    );
    expect(layout.event.dimmed).toBe(false);
  });
});
