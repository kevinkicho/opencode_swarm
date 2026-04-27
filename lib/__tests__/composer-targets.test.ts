// Backstops the #174 broadcast regression class. Before this fix,
// broadcast routed only to the "primary" session, silently dropping
// messages to every other live worker. The pure helper here pins the
// fan-out shape so a future "simplification" can't quietly re-introduce
// the bug.

import { describe, it, expect } from 'vitest';
import { resolveSendTargets } from '../composer-targets';
import type { Agent } from '../swarm-types';

// Default: agents get sessionID = `ses_${id}`. `unbound: true` simulates
// a pre-bind agent (no sessionID). `sessionID: 'ses_x'` overrides the
// default to test session-sharing across multiple agents. JS default-
// param semantics mean a literal `undefined` still triggers the default,
// so we use an explicit options object.
function makeAgent(
  id: string,
  opts: { unbound?: boolean; sessionID?: string } = {},
): Agent {
  return {
    id,
    sessionID: opts.unbound ? undefined : (opts.sessionID ?? `ses_${id}`),
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
    accent: 'mint',
    glyph: '·',
    tools: [],
  };
}

describe('resolveSendTargets — broadcast fan-out', () => {
  it('broadcast returns one entry per distinct sessionID', () => {
    const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
    const out = resolveSendTargets({ kind: 'broadcast' }, agents, 'fallback');
    expect(out.sort()).toEqual(['ses_a', 'ses_b', 'ses_c']);
  });

  it('broadcast dedupes when two agents share a session', () => {
    // E.g. orchestrator-worker patterns where the planner + synthesizer
    // can run inside one opencode session. Two POSTs would replay the
    // directive twice for that session.
    const agents = [
      makeAgent('a', { sessionID: 'ses_shared' }),
      makeAgent('b', { sessionID: 'ses_shared' }),
      makeAgent('c', { sessionID: 'ses_solo' }),
    ];
    const out = resolveSendTargets({ kind: 'broadcast' }, agents, 'fallback');
    expect(out.sort()).toEqual(['ses_shared', 'ses_solo']);
  });

  it('broadcast skips agents without a sessionID (pre-bind)', () => {
    const agents = [makeAgent('a'), makeAgent('b', { unbound: true }), makeAgent('c')];
    const out = resolveSendTargets({ kind: 'broadcast' }, agents, 'fallback');
    expect(out.sort()).toEqual(['ses_a', 'ses_c']);
  });

  it('broadcast on empty roster returns empty list (no fallback POST)', () => {
    // Important: an empty broadcast must NOT post to the fallback. The
    // fallback is for direct-to-agent sends where the agent's sessionID
    // is missing — broadcast already considers fallback an unrelated
    // primary session and shouldn't surprise-fire it.
    const out = resolveSendTargets({ kind: 'broadcast' }, [], 'fallback');
    expect(out).toEqual([]);
  });
});

describe('resolveSendTargets — direct agent send', () => {
  it("uses the target agent's sessionID when bound", () => {
    const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
    const out = resolveSendTargets({ kind: 'agent', id: 'b' }, agents, 'fallback');
    expect(out).toEqual(['ses_b']);
  });

  it('falls back to the run primary when the agent is unbound', () => {
    const agents = [makeAgent('a'), makeAgent('b', { unbound: true })];
    const out = resolveSendTargets({ kind: 'agent', id: 'b' }, agents, 'ses_primary');
    expect(out).toEqual(['ses_primary']);
  });

  it('falls back when the target id is unknown to the roster', () => {
    // Defensive: an agent that disappeared from the roster mid-flight
    // shouldn't crash the send — route to the primary as a degraded
    // fallback rather than dropping the message.
    const out = resolveSendTargets(
      { kind: 'agent', id: 'ghost' },
      [makeAgent('a')],
      'ses_primary',
    );
    expect(out).toEqual(['ses_primary']);
  });

  it('always returns exactly one entry for direct sends', () => {
    const agents = [makeAgent('a'), makeAgent('b')];
    const out = resolveSendTargets({ kind: 'agent', id: 'a' }, agents, 'ses_primary');
    expect(out).toHaveLength(1);
  });
});
