//
// `tickCoordinator` in dispatch.ts is the heart of the blackboard work
// loop. The Q34 silent-drop class lives here; so do the CAS races, the
// stale-retry budget, the role-budget guard, the critic gate, and the
// verifier gate. With zero tests it had been a black box.
//
// Strategy: mock every IO dep (opencode-server, swarm-registry, store,
// wait, critic, verifier) and drive tickCoordinator through each exit
// path. Pure helpers (path-utils, heat, message-helpers, retry) stay
// real — their inputs are constructed in-test, so coverage of those
// functions is incidental but welcome.
//
// Cases covered (per #127 verification: ≥30 cases, dispatch.ts > 70%):
//   - Happy path × 3 (default picker / restrictToSessionID / excludeSessionIDs)
//   - 8 skipped exits (run-not-found, run-no-sessions, no-open-todos,
//     retry-exhausted, claim-cas-lost, no-idle-session, role-budget-hit,
//     strict-role-no-match, restrict-busy-or-unknown × 2)
//   - 6 stale exits (prompt-send-failed, turn-timed-out, turn-errored,
//     turn-silent, phantom-no-tools Q42, critic-rejected, verifier-rejected,
//     cas-drift)
//   - Q34 silent-drop firewall: empty assistant turn, no parts after
//     deadline (covered by phantom-no-tools + turn-errored coverage)
//   - restrictToSessionID semantics (positive + negative)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardItem } from '../../../../blackboard/types';
import type { OpencodeMessage } from '../../../../opencode/types';
import type { SwarmRunMeta } from '../../../../swarm-run-types';

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  listBoardItems: vi.fn(),
  transitionStatus: vi.fn(),
  getSessionMessagesServer: vi.fn(),
  postSessionMessageServer: vi.fn(),
  abortSessionServer: vi.fn(),
  waitForSessionIdle: vi.fn(),
  reviewWorkerDiff: vi.fn(),
  verifyWorkerOutcome: vi.fn(),
  scheduleCasDriftReplan: vi.fn(),
  opencodeAgentForSession: vi.fn(),
  roleNamesBySessionID: vi.fn(),
  sha7: vi.fn(),
}));

vi.mock('../../../swarm-registry', () => ({
  getRun: mocks.getRun,
}));
vi.mock('../../../opencode-server', () => ({
  abortSessionServer: mocks.abortSessionServer,
  getSessionMessagesServer: mocks.getSessionMessagesServer,
  postSessionMessageServer: mocks.postSessionMessageServer,
}));
vi.mock('../../store', () => ({
  listBoardItems: mocks.listBoardItems,
  transitionStatus: mocks.transitionStatus,
}));
vi.mock('../wait', () => ({
  waitForSessionIdle: mocks.waitForSessionIdle,
}));
vi.mock('../../critic', () => ({
  reviewWorkerDiff: mocks.reviewWorkerDiff,
}));
vi.mock('../../verifier', () => ({
  verifyWorkerOutcome: mocks.verifyWorkerOutcome,
}));
vi.mock('../drift', () => ({
  scheduleCasDriftReplan: mocks.scheduleCasDriftReplan,
}));
vi.mock('../../../../blackboard/roles', () => ({
  opencodeAgentForSession: mocks.opencodeAgentForSession,
  roleNamesBySessionID: mocks.roleNamesBySessionID,
}));
// path-utils stays mostly real, but sha7 hits the filesystem — mock it
// to a stable sentinel so claim/commit hash flows don't depend on disk.
vi.mock('../path-utils', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    sha7: mocks.sha7,
  };
});

// Import after mocks bind.
const { tickCoordinator } = await import('../dispatch');

// --- factories -------------------------------------------------------------

function makeMeta(overrides: Partial<SwarmRunMeta> = {}): SwarmRunMeta {
  return {
    swarmRunID: 'run_test',
    pattern: 'blackboard',
    createdAt: Date.now() - 60_000,
    workspace: '/tmp/test-workspace',
    sessionIDs: ['ses_a', 'ses_b'],
    directive: 'test directive',
    ...overrides,
  } as SwarmRunMeta;
}

function makeItem(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 't_001',
    kind: 'todo',
    content: 'do the thing',
    status: 'open',
    createdAtMs: Date.now() - 30_000,
    ...overrides,
  };
}

// Construct an assistant message that looks like a completed turn with
// one patch part. The `editedPaths` argument controls what the worker
// "edited"; an empty array models a no-op turn.
function makeAssistantTurn(
  sessionID: string,
  editedPaths: string[] = ['src/foo.ts'],
  overrides?: { hasTool?: boolean; hasText?: boolean; text?: string },
): OpencodeMessage {
  const messageID = `msg_${Math.random().toString(36).slice(2, 8)}`;
  const parts: OpencodeMessage['parts'] = [];
  if (overrides?.hasText !== false) {
    parts.push({
      type: 'text',
      id: `prt_text_${messageID}`,
      sessionID,
      messageID,
      text: overrides?.text ?? 'done.',
    });
  }
  if (overrides?.hasTool) {
    parts.push({
      type: 'tool',
      id: `prt_tool_${messageID}`,
      sessionID,
      messageID,
      tool: 'read',
      state: { status: 'completed' },
    });
  }
  if (editedPaths.length > 0) {
    parts.push({
      type: 'patch',
      id: `prt_patch_${messageID}`,
      sessionID,
      messageID,
      hash: 'abc1234',
      files: editedPaths,
    });
  }
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      time: { created: Date.now() - 5_000, completed: Date.now() - 1_000 },
    },
    parts,
  };
}

// --- defaults ---------------------------------------------------------------

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getRun.mockResolvedValue(makeMeta());
  mocks.listBoardItems.mockReturnValue([makeItem()]);
  mocks.getSessionMessagesServer.mockResolvedValue([]); // idle by default
  mocks.postSessionMessageServer.mockResolvedValue(undefined);
  mocks.abortSessionServer.mockResolvedValue(undefined);
  mocks.opencodeAgentForSession.mockReturnValue(undefined);
  mocks.roleNamesBySessionID.mockReturnValue(new Map());
  mocks.sha7.mockResolvedValue('aaaaaaa');

  // Default transitionStatus succeeds for every call. Tests that need
  // CAS-loss override per-call.
  mocks.transitionStatus.mockImplementation(
    (
      _runID: string,
      _itemId: string,
      input: { to: string },
    ) => ({ ok: true, item: { ...makeItem(), status: input.to } }),
  );

  // Default wait: assistant turn completes successfully with one edit.
  mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
    const turn = makeAssistantTurn(sessionID, ['src/foo.ts']);
    return {
      ok: true,
      messages: [turn],
      newIDs: new Set([turn.info.id]),
    };
  });
});

afterEach(() => vi.restoreAllMocks());

// === Happy path =============================================================

describe('tickCoordinator · happy path', () => {
  it('claims an open todo, dispatches to an idle session, returns picked', async () => {
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('picked');
    if (result.status === 'picked') {
      expect(result.itemID).toBe('t_001');
      expect(result.sessionID).toBe('ses_a');
      expect(result.editedPaths).toEqual(['src/foo.ts']);
    }
    // Three transitions: open→claimed, claimed→in-progress, in-progress→done.
    expect(mocks.transitionStatus).toHaveBeenCalledTimes(3);
    expect(mocks.postSessionMessageServer).toHaveBeenCalledOnce();
  });

  it('honors restrictToSessionID — picks only the named session', async () => {
    const result = await tickCoordinator('run_test', {
      restrictToSessionID: 'ses_b',
    });
    expect(result.status).toBe('picked');
    if (result.status === 'picked') {
      expect(result.sessionID).toBe('ses_b');
    }
  });

  it('honors excludeSessionIDs — skips excluded session', async () => {
    const result = await tickCoordinator('run_test', {
      excludeSessionIDs: ['ses_a'],
    });
    expect(result.status).toBe('picked');
    if (result.status === 'picked') {
      expect(result.sessionID).toBe('ses_b');
    }
  });

  it('passes pinned model to opencode when teamModels is set', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({ teamModels: ['ollama/glm-5.1:cloud', 'ollama/gemma:cloud'] }),
    );
    await tickCoordinator('run_test');
    expect(mocks.postSessionMessageServer).toHaveBeenCalledWith(
      'ses_a',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ model: 'ollama/glm-5.1:cloud' }),
    );
  });

  it('overrides per-session model with synthesisModel for synthesize todos', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({
        teamModels: ['ollama/glm-5.1:cloud'],
        synthesisModel: 'opencode-zen/grok-code',
      }),
    );
    mocks.listBoardItems.mockReturnValue([
      makeItem({ kind: 'synthesize', content: 'reduce: write final summary' }),
    ]);
    await tickCoordinator('run_test');
    expect(mocks.postSessionMessageServer).toHaveBeenCalledWith(
      'ses_a',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ model: 'opencode-zen/grok-code' }),
    );
  });
});

// === Skipped exits ==========================================================

describe('tickCoordinator · skipped exits', () => {
  it('skipped:run-not-found when getRun returns null', async () => {
    mocks.getRun.mockResolvedValue(null);
    const result = await tickCoordinator('run_test');
    expect(result).toEqual({ status: 'skipped', reason: 'run not found' });
  });

  it('skipped:run-has-no-sessions when sessionIDs is empty', async () => {
    mocks.getRun.mockResolvedValue(makeMeta({ sessionIDs: [] }));
    const result = await tickCoordinator('run_test');
    expect(result).toEqual({ status: 'skipped', reason: 'run has no sessions' });
  });

  it('skipped:no-open-todos when board is empty', async () => {
    mocks.listBoardItems.mockReturnValue([]);
    const result = await tickCoordinator('run_test');
    expect(result).toEqual({ status: 'skipped', reason: 'no open todos' });
  });

  it('skipped:no-claimable-todos when only retry-exhausted opens remain', async () => {
    mocks.listBoardItems.mockReturnValue([
      makeItem({ note: '[retry:2] previous fail' }),
    ]);
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/retry-exhausted/);
    }
  });

  it('skipped:no-idle-sessions when every session is busy on board', async () => {
    // ownerIdForSession returns 'ag_ses_' + sessionID.slice(-8); for the
    // short test IDs that's 'ag_ses_ses_a' / 'ag_ses_ses_b'.
    mocks.listBoardItems.mockReturnValue([
      makeItem({ id: 't_a', status: 'in-progress', ownerAgentId: 'ag_ses_ses_a' }),
      makeItem({ id: 't_b', status: 'in-progress', ownerAgentId: 'ag_ses_ses_b' }),
      makeItem(), // open
    ]);
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/no idle sessions/);
    }
  });

  it('skipped:claim-lost-race when transition open→claimed misses CAS', async () => {
    mocks.transitionStatus.mockImplementationOnce(() => ({
      ok: false,
      currentStatus: 'claimed',
    }));
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/claim lost race/);
    }
  });

  it('skipped:start-lost-race when claimed→in-progress misses CAS', async () => {
    let calls = 0;
    mocks.transitionStatus.mockImplementation(() => {
      calls += 1;
      if (calls === 2) return { ok: false, currentStatus: 'open' };
      return { ok: true, item: makeItem() };
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/start lost race/);
    }
  });

  it('skipped:restricted-session-unknown when restrictToSessionID is not in run', async () => {
    const result = await tickCoordinator('run_test', {
      restrictToSessionID: 'ses_unknown',
    });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/no open todos|busy or unknown/);
    }
  });

  it('skipped:role-budget-hit when picked session role exceeds cap', async () => {
    const meta = makeMeta({
      pattern: 'role-differentiated',
      roleBudgets: { engineer: 100 },
    });
    mocks.getRun.mockResolvedValue(meta);
    mocks.roleNamesBySessionID.mockReturnValue(
      new Map([['ses_a', 'engineer']]),
    );
    // Return one assistant message with high tokens to exceed cap.
    mocks.getSessionMessagesServer.mockResolvedValue([
      {
        info: {
          id: 'msg_high',
          sessionID: 'ses_a',
          role: 'assistant',
          time: { created: Date.now() - 60_000, completed: Date.now() - 30_000 },
          tokens: {
            total: 200,
            input: 100,
            output: 100,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      },
    ] as OpencodeMessage[]);
    const result = await tickCoordinator('run_test', {
      restrictToSessionID: 'ses_a',
    });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/role-budget/);
    }
  });

  it('skipped:strict-role-no-match when no todos match the session role', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({ pattern: 'role-differentiated', strictRoleRouting: true }),
    );
    mocks.roleNamesBySessionID.mockReturnValue(new Map([['ses_a', 'engineer']]));
    mocks.listBoardItems.mockReturnValue([
      makeItem({ preferredRole: 'reviewer' }),
    ]);
    const result = await tickCoordinator('run_test', {
      restrictToSessionID: 'ses_a',
    });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/strict-role/);
    }
  });
});

// === Stale exits ============================================================

describe('tickCoordinator · stale exits', () => {
  it('stale on prompt-send-failed when postSessionMessageServer throws', async () => {
    mocks.postSessionMessageServer.mockRejectedValue(
      new Error('opencode 503'),
    );
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/prompt-send failed|opencode 503/);
    }
  });

  it('stale on turn-timed-out — wait returns timeout', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({
      ok: false,
      reason: 'timeout',
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/timed out/);
    }
    // Eager abort fires on timeout (fire-and-forget).
    expect(mocks.abortSessionServer).toHaveBeenCalledOnce();
  });

  it('stale on turn-errored — wait returns error', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({ ok: false, reason: 'error' });
    // Re-fetch for error-text enrichment returns an errored assistant.
    mocks.getSessionMessagesServer.mockResolvedValueOnce([]).mockResolvedValue([
      {
        info: {
          id: 'msg_err',
          sessionID: 'ses_a',
          role: 'assistant',
          time: { created: Date.now() - 5_000 },
          error: { name: 'ProviderError', data: { message: 'overloaded' } },
        },
        parts: [],
      },
    ] as OpencodeMessage[]);
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/turn errored/);
    }
  });

  it('stale on turn-silent — wait returns silent', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({ ok: false, reason: 'silent' });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/turn went silent/);
    }
  });

  it('stale on tool-loop — wait returns tool-loop', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({
      ok: false,
      reason: 'tool-loop',
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/tool-loop/);
    }
  });

  it('stale on phantom-no-tools (Q42) — text-only response, no tools, no patches', async () => {
    mocks.waitForSessionIdle.mockResolvedValue({
      ok: true,
      messages: [
        makeAssistantTurn('ses_a', [], {
          hasText: true,
          text: '<tool>glob<arg_key>files</arg_key></tool>',
          hasTool: false,
        }),
      ],
      newIDs: new Set(['msg_phantom']),
    });
    // Override message ID matching by binding the new turn id properly.
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeAssistantTurn(sessionID, [], {
        hasText: true,
        text: '<tool>glob<arg_key>files</arg_key></tool>',
        hasTool: false,
      });
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/phantom-no-tools/);
    }
  });

  it('does NOT bounce phantom when worker text begins with skip:', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeAssistantTurn(sessionID, [], {
        hasText: true,
        text: 'skip: nothing to do here',
        hasTool: false,
      });
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('picked'); // legitimate skip → done
  });

  it('does NOT bounce phantom when worker made a real tool call (research)', async () => {
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeAssistantTurn(sessionID, [], {
        hasText: true,
        text: 'looked at three files, no edits needed',
        hasTool: true,
      });
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('picked'); // research turn → done
  });

  it('stale on critic-rejected when critic returns busywork', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({ enableCriticGate: true, criticSessionID: 'ses_critic' }),
    );
    mocks.reviewWorkerDiff.mockResolvedValue({
      verdict: 'busywork',
      reason: 'no real change',
      rawReply: '',
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/critic-rejected/);
    }
  });

  it('substantive critic verdict falls through to done', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({ enableCriticGate: true, criticSessionID: 'ses_critic' }),
    );
    mocks.reviewWorkerDiff.mockResolvedValue({
      verdict: 'substantive',
      reason: 'ok',
      rawReply: '',
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('picked');
  });

  it('unclear critic verdict fails open (logs but proceeds to done)', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({ enableCriticGate: true, criticSessionID: 'ses_critic' }),
    );
    mocks.reviewWorkerDiff.mockResolvedValue({
      verdict: 'unclear',
      reason: 'parse error',
      rawReply: '',
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('picked');
  });

  it('stale on verifier-rejected when verifier returns not-verified', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({
        enableVerifierGate: true,
        verifierSessionID: 'ses_verify',
        workspaceDevUrl: 'http://localhost:3000',
      }),
    );
    mocks.listBoardItems.mockReturnValue([
      makeItem({ requiresVerification: true }),
    ]);
    mocks.verifyWorkerOutcome.mockResolvedValue({
      verdict: 'not-verified',
      reason: 'feature did not render',
      rawReply: '',
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/verifier-rejected/);
    }
  });

  it('verifier skipped when item does NOT requireVerification', async () => {
    mocks.getRun.mockResolvedValue(
      makeMeta({
        enableVerifierGate: true,
        verifierSessionID: 'ses_verify',
        workspaceDevUrl: 'http://localhost:3000',
      }),
    );
    // Item without requiresVerification → verifier never consulted.
    mocks.listBoardItems.mockReturnValue([makeItem()]);
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('picked');
    expect(mocks.verifyWorkerOutcome).not.toHaveBeenCalled();
  });

  it('stale on cas-drift — claim anchor mismatches commit-time hash', async () => {
    // Planner pre-anchored bar.ts at hash 'aaaaaaa' on the todo's
    // fileHashes. Worker only edits foo.ts; bar.ts gets re-hashed at
    // commit time and now returns 'bbbbbbb' → drift.
    mocks.listBoardItems.mockReturnValue([
      makeItem({
        expectedFiles: ['src/foo.ts', 'src/bar.ts'],
        fileHashes: [
          { path: 'src/foo.ts', sha: 'aaaaaaa' },
          { path: 'src/bar.ts', sha: 'aaaaaaa' },
        ],
      }),
    ]);
    // Claim-time path: dispatch reads both expectedFiles and writes new
    // anchors (still 'aaaaaaa'). Commit-time path: re-reads bar.ts only
    // (foo.ts is in editedPaths, filtered out) and now sees 'bbbbbbb'.
    // Track per-path call counts so the order of Promise.all doesn't
    // matter.
    const callsByPath: Record<string, number> = {};
    mocks.sha7.mockImplementation(async (abs: string) => {
      const key = abs.endsWith('foo.ts') ? 'foo' : 'bar';
      callsByPath[key] = (callsByPath[key] ?? 0) + 1;
      if (key === 'bar' && callsByPath.bar >= 2) return 'bbbbbbb';
      return 'aaaaaaa';
    });
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn = makeAssistantTurn(sessionID, ['src/foo.ts']);
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await tickCoordinator('run_test');
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/cas-drift/);
    }
    expect(mocks.scheduleCasDriftReplan).toHaveBeenCalledOnce();
  });
});

// === restrictToSessionID semantics ==========================================

describe('tickCoordinator · restrictToSessionID', () => {
  it('only considers the named session — never picks ses_a if restricted to ses_b', async () => {
    // 5 ticks with restrictToSessionID=ses_b: every pick must be ses_b.
    for (let i = 0; i < 5; i++) {
      const result = await tickCoordinator('run_test', {
        restrictToSessionID: 'ses_b',
      });
      if (result.status === 'picked') {
        expect(result.sessionID).toBe('ses_b');
      }
    }
  });

  it('returns skipped when restricted session is busy on board', async () => {
    mocks.listBoardItems.mockReturnValue([
      // ses_b owns an in-progress item — busy on board.
      makeItem({ id: 't_busy', status: 'in-progress', ownerAgentId: 'ag_ses_ses_b' }),
      makeItem(), // open todo
    ]);
    const result = await tickCoordinator('run_test', {
      restrictToSessionID: 'ses_b',
    });
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toMatch(/busy|no idle/);
    }
  });

  it('exclude wins over restrict — both pointing at the same session', async () => {
    const result = await tickCoordinator('run_test', {
      restrictToSessionID: 'ses_a',
      excludeSessionIDs: ['ses_a'],
    });
    expect(result.status).toBe('skipped');
  });
});

// === Q34 silent-drop firewall (regression probes) ===========================

describe('tickCoordinator · Q34 silent-drop firewall', () => {
  it('rejects a turn with zero parts (no assistant content)', async () => {
    // Worker emits a "completed" turn with literally no parts at all.
    mocks.waitForSessionIdle.mockImplementation(async (sessionID: string) => {
      const turn: OpencodeMessage = {
        info: {
          id: 'msg_empty',
          sessionID,
          role: 'assistant',
          time: { created: Date.now() - 5_000, completed: Date.now() - 1_000 },
        },
        parts: [],
      };
      return {
        ok: true,
        messages: [turn],
        newIDs: new Set([turn.info.id]),
      };
    });
    const result = await tickCoordinator('run_test');
    // Phantom-no-tools guard catches this: zero tool/patch parts and no
    // skip: prefix → bounce to stale. Silent drop class.
    expect(result.status).toBe('stale');
    if (result.status === 'stale') {
      expect(result.reason).toMatch(/phantom-no-tools/);
    }
  });
});
