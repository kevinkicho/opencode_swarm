import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAssistant } from '../../__tests__/_helpers/fake-message';
import type { OpencodeServerMocks } from '../../__tests__/_helpers/mock-opencode';

// #100 — waitForSessionIdle deadline-abort test. The MAXTEAM-2026-04-26
// critic-loop runaway burned 955K tokens / 30 min on a worker turn that
// never completed: the orchestrator gave up after ITERATION_WAIT_MS but
// the helper returned 'timeout' WITHOUT aborting the session, so opencode
// kept tokenating an abandoned turn forever. The fix: track lastSeenInProgress
// inside the poll loop, and on deadline-expiry abort the session if the
// most recent poll observed an in-progress turn. Drift in this behavior
// re-opens the runaway-token leak silently — the orchestrator-side timeout
// path masks the bleed.
//
// Mocks the opencode-server transport so the test is hermetic. Uses real
// timers (with a short deadline) so the loop runs through one or two real
// 1s polls — slower than fake timers, but more faithful to the production
// timing. POLL_INTERVAL_MS = 1000 (private to coordinator), so the test
// takes ~1-2s to complete.

const opencodeMocks: OpencodeServerMocks = vi.hoisted(() => ({
  getSessionMessagesServer: vi.fn().mockResolvedValue([]),
  abortSessionServer: vi.fn().mockResolvedValue(undefined),
  postSessionMessageServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../opencode-server', () => opencodeMocks);
// Other transitively-loaded modules don't need behavior mocks for this
// test (they're only touched by other coordinator code paths). But we
// mock the SQLite-backed ones so that opening the module doesn't write
// to disk.
vi.mock('../store', () => ({
  listBoardItems: vi.fn(() => []),
  transitionStatus: vi.fn(),
}));
vi.mock('../critic', () => ({
  reviewWorkerDiff: vi.fn(),
}));
vi.mock('../verifier', () => ({
  verifyWorkerOutcome: vi.fn(),
}));
vi.mock('../../swarm-registry', () => ({
  getRun: vi.fn(),
}));
vi.mock('../planner', () => ({
  runPlannerSweep: vi.fn(),
}));

const { waitForSessionIdle } = await import('../coordinator');

const mockGet = opencodeMocks.getSessionMessagesServer;
const mockAbort = opencodeMocks.abortSessionServer;

beforeEach(() => {
  mockGet.mockReset();
  mockAbort.mockReset();
  mockAbort.mockResolvedValue(undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('waitForSessionIdle — deadline expiry', () => {
  it('aborts the session when deadline expires with an in-progress turn', async () => {
    // The session keeps emitting parts (no completed timestamp) — the
    // exact shape that bypassed F1 silent-watchdog (parts grow) and
    // tool-loop detector (no error parts), but ate the wall-clock cap.
    mockGet.mockResolvedValue([
      makeAssistant({ id: 'turn1', completed: null, parts: 5 }),
    ]);

    const deadline = Date.now() + 100; // very short deadline
    const result = await waitForSessionIdle(
      'sid_test',
      '/tmp/ws',
      new Set(),
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
    // The abort is the load-bearing behavior — verifies the leak fix.
    expect(mockAbort).toHaveBeenCalledWith('sid_test', '/tmp/ws');
  }, 10_000);

  it('does NOT abort when deadline expires with no new messages', async () => {
    // Empty new-assistant set → lastSeenInProgress stays false →
    // no abort on deadline. (The session is already idle, just hasn't
    // produced anything during this dispatch's window.)
    mockGet.mockResolvedValue([]);

    const deadline = Date.now() + 100;
    const result = await waitForSessionIdle(
      'sid_quiet',
      '/tmp/ws',
      new Set(),
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
    expect(mockAbort).not.toHaveBeenCalled();
  }, 10_000);

  it('does NOT abort when last poll saw all turns completed', async () => {
    // All assistants completed — lastSeenInProgress=false at deadline.
    // The session is already idle; aborting would be theater.
    mockGet.mockResolvedValue([
      makeAssistant({
        id: 'done-turn',
        completed: Date.now() - 100,
        parts: 3,
      }),
    ]);

    // Short deadline so we don't wait the SESSION_IDLE_QUIET_MS for
    // a clean ok=true — the deadline expires in the quiet window.
    const deadline = Date.now() + 100;
    const result = await waitForSessionIdle(
      'sid_done',
      '/tmp/ws',
      new Set(),
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
    expect(mockAbort).not.toHaveBeenCalled();
  }, 10_000);

  it('returns reason=error when an errored assistant message lands', async () => {
    mockGet.mockResolvedValue([
      makeAssistant({
        id: 'err-turn',
        completed: null,
        parts: 2,
        error: { name: 'ProviderAuthError', message: 'bad token' },
      }),
    ]);

    const deadline = Date.now() + 5000; // generous; error fires fast
    const result = await waitForSessionIdle(
      'sid_err',
      '/tmp/ws',
      new Set(),
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('error');
    }
  }, 10_000);
});
