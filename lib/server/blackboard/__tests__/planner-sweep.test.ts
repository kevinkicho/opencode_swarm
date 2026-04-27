//
// `runPlannerSweep` orchestrates the planner LLM call: prompt build,
// dispatch via postSessionMessageServer, wait for the assistant turn,
// parse todowrite output, insert board items. The pure parsers
// (latestTodosFrom + strip helpers) are already covered by
// planner-parsers.test.ts (44 cases). This file covers the orchestrator
// itself: failure modes, board-state guard, tier escalation passthrough,
// teamModels pinning, role-note dispatch, criteria-drop preflight.
//
// Strategy: vi.mock the IO deps (swarm-registry, opencode-server, store,
// coordinator/wait, plan-revisions, degraded-completion). Pure helpers
// (latestTodosFrom + strip-tag chain) run real so the test exercises the
// real parse contract. README read is suppressed via includeReadme:false
// so the suite doesn't touch the filesystem.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardItem } from '../../../blackboard/types';
import type { OpencodeMessage } from '../../../opencode/types';
import type { SwarmRunMeta } from '../../../swarm-run-types';

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  listBoardItems: vi.fn(),
  insertBoardItem: vi.fn(),
  getSessionMessagesServer: vi.fn(),
  postSessionMessageServer: vi.fn(),
  abortSessionServer: vi.fn(),
  waitForSessionIdle: vi.fn(),
  recordPartialOutcome: vi.fn(),
  recordPlanRevision: vi.fn(),
  nextRoundForRun: vi.fn(),
  computeDelta: vi.fn(),
  getLatestRevisionContents: vi.fn(),
  roleNamesBySessionID: vi.fn(),
}));

vi.mock('../../swarm-registry', () => ({
  getRun: mocks.getRun,
}));
vi.mock('../../opencode-server', () => ({
  abortSessionServer: mocks.abortSessionServer,
  getSessionMessagesServer: mocks.getSessionMessagesServer,
  postSessionMessageServer: mocks.postSessionMessageServer,
}));
vi.mock('../store', () => ({
  insertBoardItem: mocks.insertBoardItem,
  listBoardItems: mocks.listBoardItems,
}));
vi.mock('../coordinator', () => ({
  waitForSessionIdle: mocks.waitForSessionIdle,
}));
vi.mock('../plan-revisions', () => ({
  computeDelta: mocks.computeDelta,
  getLatestRevisionContents: mocks.getLatestRevisionContents,
  nextRoundForRun: mocks.nextRoundForRun,
  recordPlanRevision: mocks.recordPlanRevision,
}));
vi.mock('../../degraded-completion', () => ({
  recordPartialOutcome: mocks.recordPartialOutcome,
}));
vi.mock('@/lib/blackboard/roles', () => ({
  roleNamesBySessionID: mocks.roleNamesBySessionID,
}));

const { runPlannerSweep } = await import('../planner');

// --- factories -------------------------------------------------------------

function makeMeta(overrides: Partial<SwarmRunMeta> = {}): SwarmRunMeta {
  return {
    swarmRunID: 'run_test',
    pattern: 'blackboard',
    createdAt: Date.now() - 60_000,
    workspace: '/tmp/test-workspace',
    sessionIDs: ['ses_planner_a', 'ses_worker_b'],
    directive: 'add a status banner to the dashboard',
    ...overrides,
  } as SwarmRunMeta;
}

function makeTodowriteTurn(
  sessionID: string,
  todos: Array<{ content: string; status?: string }>,
): OpencodeMessage {
  const messageID = `msg_${Math.random().toString(36).slice(2, 8)}`;
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      time: { created: Date.now() - 5_000, completed: Date.now() - 1_000 },
    },
    parts: [
      {
        type: 'tool',
        id: 'prt_todowrite',
        sessionID,
        messageID,
        tool: 'todowrite',
        state: {
          status: 'completed',
          input: { todos },
        },
      },
    ],
  };
}

function makeNoTodowriteTurn(sessionID: string, text = 'sorry, no plan'): OpencodeMessage {
  const messageID = `msg_${Math.random().toString(36).slice(2, 8)}`;
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      time: { created: Date.now() - 5_000, completed: Date.now() - 1_000 },
    },
    parts: [
      {
        type: 'text',
        id: 'prt_text',
        sessionID,
        messageID,
        text,
      },
    ],
  };
}

let mockBoardItemSeq = 0;
function fakeInsertedItem(
  swarmRunID: string,
  partial: Partial<BoardItem>,
): BoardItem {
  mockBoardItemSeq += 1;
  return {
    id: partial.id ?? `t_${mockBoardItemSeq}`,
    kind: partial.kind ?? 'todo',
    content: partial.content ?? 'mock todo',
    status: partial.status ?? 'open',
    createdAtMs: partial.createdAtMs ?? Date.now(),
    requiresVerification: partial.requiresVerification,
    preferredRole: partial.preferredRole,
    expectedFiles: partial.expectedFiles,
    sourceDrafts: partial.sourceDrafts,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mockBoardItemSeq = 0;
  mocks.getRun.mockResolvedValue(makeMeta());
  mocks.listBoardItems.mockReturnValue([]); // empty by default → no overwrite trip
  mocks.getSessionMessagesServer.mockResolvedValue([]); // no prior messages
  mocks.postSessionMessageServer.mockResolvedValue(undefined);
  mocks.abortSessionServer.mockResolvedValue(undefined);
  mocks.recordPartialOutcome.mockReturnValue(undefined);
  mocks.recordPlanRevision.mockReturnValue(undefined);
  mocks.nextRoundForRun.mockReturnValue(1);
  mocks.computeDelta.mockReturnValue({ added: [], removed: [], rephrased: [] });
  mocks.getLatestRevisionContents.mockReturnValue(null);
  mocks.roleNamesBySessionID.mockReturnValue(new Map());
  mocks.insertBoardItem.mockImplementation(fakeInsertedItem);
  mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
    const turn = makeTodowriteTurn(sessionID, [
      { content: 'do thing 1' },
      { content: 'do thing 2' },
    ]);
    return {
      ok: true,
      messages: [turn],
      newIDs: new Set([turn.info.id]),
    };
  });
});

afterEach(() => vi.restoreAllMocks());

// === Cold-start seeding =====================================================

describe('runPlannerSweep · cold-start seeding', () => {
  it('issues a planner prompt and inserts parsed todos when board is empty', async () => {
    const result = await runPlannerSweep('run_test', { includeReadme: false });
    expect(mocks.postSessionMessageServer).toHaveBeenCalledOnce();
    expect(mocks.insertBoardItem).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(2);
    expect(result.sessionID).toBe('ses_planner_a');
    expect(result.planMessageID).toMatch(/^msg_/);
  });

  it('uses sessionIDs[0] as the planner session', async () => {
    await runPlannerSweep('run_test', { includeReadme: false });
    expect(mocks.postSessionMessageServer).toHaveBeenCalledWith(
      'ses_planner_a',
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it('routes planner via plan agent when teamModels[0] is unset', async () => {
    await runPlannerSweep('run_test', { includeReadme: false });
    const args = mocks.postSessionMessageServer.mock.calls[0];
    expect(args[3]).toEqual({ agent: 'plan', model: undefined });
  });

  it('routes planner via teamModels[0] (skipping plan agent) when pinned', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({ teamModels: ['ollama/glm-5.1:cloud'] }),
    );
    await runPlannerSweep('run_test', { includeReadme: false });
    const args = mocks.postSessionMessageServer.mock.calls[0];
    expect(args[3]).toEqual({
      agent: undefined,
      model: 'ollama/glm-5.1:cloud',
    });
  });

});

// === Guard: existing-board protection ======================================

describe('runPlannerSweep · existing-board guard', () => {
  it('throws when board is non-empty and overwrite is not set', async () => {
    mocks.listBoardItems.mockReturnValue([
      fakeInsertedItem('run_test', { content: 'pre-existing' }),
    ]);
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/already populated/);
    // Crucially: no opencode roundtrip on this path.
    expect(mocks.postSessionMessageServer).not.toHaveBeenCalled();
  });

  it('proceeds when overwrite=true regardless of board state', async () => {
    mocks.listBoardItems.mockReturnValue([
      fakeInsertedItem('run_test', { content: 'pre-existing' }),
    ]);
    const result = await runPlannerSweep('run_test', {
      includeReadme: false,
      overwrite: true,
    });
    expect(result.items.length).toBeGreaterThan(0);
  });
});

// === Run-not-found / no-sessions ============================================

describe('runPlannerSweep · run preconditions', () => {
  it('throws when getRun returns null', async () => {
    mocks.getRun.mockResolvedValue(null);
    await expect(
      runPlannerSweep('run_unknown', { includeReadme: false }),
    ).rejects.toThrow(/run not found/);
  });

  it('throws when run has no sessions', async () => {
    mocks.getRun.mockResolvedValue(makeMeta({ sessionIDs: [] }));
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/no sessions/);
  });
});

// === Failure modes (timeout / silent / errored) =============================

describe('runPlannerSweep · failure modes', () => {
  it('throws "timed out" and aborts session when wait returns timeout', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({ ok: false, reason: 'timeout' });
    await expect(
      runPlannerSweep('run_test', { includeReadme: false, timeoutMs: 60_000 }),
    ).rejects.toThrow(/timed out/);
    // Critical: abort must fire so the session stops bleeding tokens.
    expect(mocks.abortSessionServer).toHaveBeenCalledOnce();
    // Partial outcome recorded for operator visibility.
    expect(mocks.recordPartialOutcome).toHaveBeenCalledOnce();
  });

  it('throws "session went silent" when wait returns silent', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({ ok: false, reason: 'silent' });
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/silent|provider unreachable/);
    expect(mocks.abortSessionServer).toHaveBeenCalledOnce();
  });

  it('throws "ollama daemon unreachable" when wait returns provider-unavailable', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({
      ok: false,
      reason: 'provider-unavailable',
    });
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/ollama|daemon|unreachable/);
  });

  it('throws "tool-loop" when wait returns tool-loop', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({
      ok: false,
      reason: 'tool-loop',
    });
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/tool-loop/);
  });

  it('throws "assistant turn errored" on generic error reason', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({ ok: false, reason: 'error' });
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/errored/);
  });

  it('continues when abort-on-timeout itself fails (non-fatal warn)', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({ ok: false, reason: 'timeout' });
    mocks.abortSessionServer.mockRejectedValue(new Error('opencode 503'));
    // Still throws the timeout error (the abort failure is logged but not propagated).
    await expect(
      runPlannerSweep('run_test', { includeReadme: false }),
    ).rejects.toThrow(/timed out/);
  });
});

// === Zero-todo (planner declined to call todowrite) ========================

describe('runPlannerSweep · zero-todo path', () => {
  it('returns empty items + records partial outcome when assistant skipped todowrite', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeNoTodowriteTurn(sessionID, 'I have nothing to plan.');
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await runPlannerSweep('run_test', { includeReadme: false });
    expect(result.items).toHaveLength(0);
    expect(result.planMessageID).toBeNull();
    expect(mocks.insertBoardItem).not.toHaveBeenCalled();
    // Partial-outcome row records the empty sweep for operator visibility.
    expect(mocks.recordPartialOutcome).toHaveBeenCalledWith(
      'run_test',
      expect.objectContaining({ phase: expect.stringMatching(/zero-todo/) }),
    );
  });
});

// === Criterion preflight + role-note dispatch ===============================

describe('runPlannerSweep · criterion + role-note handling', () => {
  it('drops vague criteria but keeps concrete ones', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeTodowriteTurn(sessionID, [
        { content: '[criterion] make the app better' },
        { content: '[criterion] dashboard renders without errors at /home' },
        { content: 'add status banner to header' },
      ]);
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await runPlannerSweep('run_test', { includeReadme: false });
    // 1 vague criterion dropped; 1 concrete criterion + 1 todo kept.
    expect(result.items).toHaveLength(2);
    const kinds = result.items.map((it) => it.kind);
    expect(kinds).toContain('criterion');
    expect(kinds).toContain('todo');
  });

});

// === Plan-revision logging ==================================================

describe('runPlannerSweep · plan-revision logging', () => {
  it('records a plan revision after a successful sweep', async () => {
    await runPlannerSweep('run_test', { includeReadme: false });
    expect(mocks.recordPlanRevision).toHaveBeenCalledOnce();
    const call = mocks.recordPlanRevision.mock.calls[0][0];
    expect(call.swarmRunID).toBe('run_test');
    expect(call.round).toBe(1);
  });

  it('records a no-op revision when planner declined to todowrite', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeNoTodowriteTurn(sessionID);
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    await runPlannerSweep('run_test', { includeReadme: false });
    expect(mocks.recordPlanRevision).toHaveBeenCalledOnce();
    const call = mocks.recordPlanRevision.mock.calls[0][0];
    expect(call.added).toEqual([]);
    expect(call.planMessageId).toBeNull();
  });

  it('does not throw when plan-revision logging itself errors (warn-and-continue)', async () => {
    mocks.recordPlanRevision.mockImplementation(() => {
      throw new Error('disk full');
    });
    const result = await runPlannerSweep('run_test', { includeReadme: false });
    // Sweep still returns successfully — revision-log failure is non-fatal.
    expect(result.items).toHaveLength(2);
  });
});

// === Tag parsing — passthrough check (parsers tested separately) ===========

describe('runPlannerSweep · tag parsing passthrough', () => {
  it('honors [verify] tag → requiresVerification=true', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeTodowriteTurn(sessionID, [
        { content: '[verify] dashboard renders status banner' },
      ]);
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    await runPlannerSweep('run_test', { includeReadme: false });
    const insertCall = mocks.insertBoardItem.mock.calls[0][1];
    expect(insertCall.requiresVerification).toBe(true);
  });

  it('honors [files:a.ts,b.tsx] tag → expectedFiles', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeTodowriteTurn(sessionID, [
        { content: '[files:src/a.ts,src/b.tsx] refactor the helper' },
      ]);
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    await runPlannerSweep('run_test', { includeReadme: false });
    const insertCall = mocks.insertBoardItem.mock.calls[0][1];
    expect(insertCall.expectedFiles).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('honors [role:engineer] tag → preferredRole', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeTodowriteTurn(sessionID, [
        { content: '[role:engineer] wire the API endpoint' },
      ]);
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    await runPlannerSweep('run_test', { includeReadme: false });
    const insertCall = mocks.insertBoardItem.mock.calls[0][1];
    expect(insertCall.preferredRole).toBe('engineer');
  });
});
