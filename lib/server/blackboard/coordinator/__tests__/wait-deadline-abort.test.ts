// POSTMORTEMS/2026-04-26-critic-loop-runaway-token.md F1 — synthetic test
// for `waitForSessionIdle` deadline-expiry abort path.
//
// Pre-fix the deadline branch returned `{ ok: false, reason: 'timeout' }`
// without aborting the still-streaming opencode session. Worker turn
// kept burning tokens forever (955K observed in MAXTEAM-2026-04-26).
// Post-fix the loop tracks `lastSeenInProgress`; if the deadline fires
// while a turn is mid-stream, abortSessionServer is called before
// returning timeout.
//
// Three cases:
//   1. Deadline expires while a turn is in-progress  → abort called
//   2. Deadline expires after a turn completed       → abort NOT called
//   3. No new assistants since dispatch              → abort NOT called

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpencodeMessage } from '../../../../opencode/types';

const mocks = vi.hoisted(() => ({
  abortSessionServer: vi.fn(),
  getSessionMessagesServer: vi.fn(),
  postSessionMessageServer: vi.fn(),
}));

vi.mock('../../../opencode-server', () => ({
  abortSessionServer: mocks.abortSessionServer,
  getSessionMessagesServer: mocks.getSessionMessagesServer,
  postSessionMessageServer: mocks.postSessionMessageServer,
}));

const { waitForSessionIdle } = await import('../wait');

function makeAssistant(
  sessionID: string,
  messageID: string,
  opts: { completedAt?: number; partsCount?: number; error?: { name: string } } = {},
): OpencodeMessage {
  const parts: OpencodeMessage['parts'] = [];
  for (let i = 0; i < (opts.partsCount ?? 1); i += 1) {
    parts.push({
      type: 'text',
      id: `prt_${messageID}_${i}`,
      sessionID,
      messageID,
      text: 'streaming…',
    });
  }
  return {
    info: {
      id: messageID,
      sessionID,
      role: 'assistant',
      time: {
        created: Date.now() - 5000,
        completed: opts.completedAt,
      },
      error: opts.error,
    },
    parts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: silent watchdog probe checks ollama; ensure it doesn't
  // accidentally fire during these tiny-deadline tests. Fetch is mocked
  // away in setup so probeOllamaPs returns ok=true within the silent
  // window of <30s these tests use.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('waitForSessionIdle · deadline-expiry abort (#100 F1)', () => {
  it('aborts the session when deadline expires with an in-progress turn', async () => {
    // Mock: every poll returns the same in-progress assistant. The model
    // is "still streaming" — message exists, parts exist, time.completed
    // is undefined. Pre-fix this would return timeout without aborting.
    const inProgressMsg = makeAssistant('ses_runaway', 'msg_streaming', {
      partsCount: 3,
    });
    mocks.getSessionMessagesServer.mockResolvedValue([inProgressMsg]);
    mocks.abortSessionServer.mockResolvedValue(undefined);

    // Deadline ≥ POLL_INTERVAL_MS (1s) so the poll runs at least once
    // and sees the in-progress turn → lastSeenInProgress=true.
    const deadline = Date.now() + 1500;

    const result = await waitForSessionIdle(
      'ses_runaway',
      '/tmp/test-workspace',
      new Set<string>(), // nothing known yet — msg_streaming counts as new
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
    // Critical assertion: the abort fired so opencode stops the runaway turn.
    expect(mocks.abortSessionServer).toHaveBeenCalledTimes(1);
    expect(mocks.abortSessionServer).toHaveBeenCalledWith(
      'ses_runaway',
      '/tmp/test-workspace',
    );
  });

  it('does NOT abort when last poll saw all turns completed', async () => {
    // Mock: poll returns one completed assistant (time.completed set
    // very recently — must be inside SESSION_IDLE_QUIET_MS=2000 so the
    // poll *doesn't* return ok=true on the quiet-window check). Setting
    // completedAt = Date.now() at test start: by the time the first
    // poll fires (~1s in), elapsed = 1000ms < 2000ms quiet window, so
    // the loop continues with lastSeenInProgress=false. Deadline then
    // expires and the timeout-abort path checks lastSeenInProgress —
    // should be false, so no abort.
    const completedMsg = makeAssistant('ses_calm', 'msg_done', {
      completedAt: Date.now(),
      partsCount: 2,
    });
    mocks.getSessionMessagesServer.mockResolvedValue([completedMsg]);
    mocks.abortSessionServer.mockResolvedValue(undefined);

    // Deadline shorter than POLL_INTERVAL_MS so the loop exits after
    // exactly one poll (the poll wakes after 1s sleep regardless,
    // but the loop check then fails).
    const deadline = Date.now() + 100;

    const result = await waitForSessionIdle(
      'ses_calm',
      '/tmp/test-workspace',
      new Set<string>(),
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
    // No abort — last poll saw completion, lastSeenInProgress=false.
    expect(mocks.abortSessionServer).not.toHaveBeenCalled();
  });

  it('does NOT abort when no new assistants exist (deadline before any reply)', async () => {
    // Mock: empty messages — no assistant has been created yet. This
    // models "deadline fired before opencode even started the turn"
    // (the prompt was queued but the worker hasn't replied at all).
    // No in-progress turn means nothing to abort.
    mocks.getSessionMessagesServer.mockResolvedValue([]);
    mocks.abortSessionServer.mockResolvedValue(undefined);

    const deadline = Date.now() + 100;

    const result = await waitForSessionIdle(
      'ses_quiet',
      '/tmp/test-workspace',
      new Set<string>(),
      deadline,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
    }
    expect(mocks.abortSessionServer).not.toHaveBeenCalled();
  });
});
