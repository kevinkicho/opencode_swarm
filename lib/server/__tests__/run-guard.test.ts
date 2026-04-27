import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRunGuard } from '../run-guard';
import { fakeMeta } from './_helpers/fake-meta';

// Mock the two modules withRunGuard depends on so the test stays
// pure (no fs reads, no opencode HTTP calls). We exercise the
// guard's branching exhaustively + assert finalizeRun is called
// on every path that ran the body.
vi.mock('../swarm-registry', () => ({
  getRun: vi.fn(),
}));
vi.mock('../finalize-run', () => ({
  finalizeRun: vi.fn(),
}));
vi.mock('../degraded-completion', () => ({
  recordPartialOutcome: vi.fn(),
}));

const { getRun } = await import('../swarm-registry');
const { finalizeRun } = await import('../finalize-run');
const { recordPartialOutcome } = await import('../degraded-completion');

const mockGetRun = vi.mocked(getRun);
const mockFinalizeRun = vi.mocked(finalizeRun);
const mockRecordPartialOutcome = vi.mocked(recordPartialOutcome);

beforeEach(() => {
  mockGetRun.mockReset();
  mockFinalizeRun.mockReset();
  mockFinalizeRun.mockResolvedValue(undefined);
  mockRecordPartialOutcome.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRunGuard', () => {
  it('returns undefined and skips body when run not found', async () => {
    mockGetRun.mockResolvedValue(null);
    const body = vi.fn();

    const out = await withRunGuard(
      'run_missing',
      { expectedPattern: 'council', context: 'council' },
      body,
    );

    expect(out).toBeUndefined();
    expect(body).not.toHaveBeenCalled();
    // No body ran, no finalizeRun should fire.
    expect(mockFinalizeRun).not.toHaveBeenCalled();
  });

  it('returns undefined and skips body on pattern mismatch', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'blackboard' }));
    const body = vi.fn();

    const out = await withRunGuard(
      'run_x',
      { expectedPattern: 'council', context: 'council' },
      body,
    );

    expect(out).toBeUndefined();
    expect(body).not.toHaveBeenCalled();
    expect(mockFinalizeRun).not.toHaveBeenCalled();
  });

  it('runs body + finalizeRun when pattern matches single', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'critic-loop' }));
    const body = vi.fn().mockResolvedValue(undefined);

    await withRunGuard(
      'run_x',
      { expectedPattern: 'critic-loop', context: 'critic-loop' },
      body,
    );

    expect(body).toHaveBeenCalledTimes(1);
    expect(mockFinalizeRun).toHaveBeenCalledWith('run_x', 'critic-loop');
  });

  it('runs body when pattern is in the allowed array', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'council' }));
    const body = vi.fn().mockResolvedValue(undefined);

    await withRunGuard(
      'run_x',
      {
        expectedPattern: ['council', 'orchestrator-worker'],
        context: 'council',
      },
      body,
    );

    expect(body).toHaveBeenCalledTimes(1);
    expect(mockFinalizeRun).toHaveBeenCalledWith('run_x', 'council');
  });

  it('rejects pattern not in the allowed array', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'blackboard' }));
    const body = vi.fn();

    await withRunGuard(
      'run_x',
      {
        expectedPattern: ['council', 'orchestrator-worker'],
        context: 'council',
      },
      body,
    );

    expect(body).not.toHaveBeenCalled();
    expect(mockFinalizeRun).not.toHaveBeenCalled();
  });

  it('still runs finalizeRun if the body throws', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'critic-loop' }));
    const body = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      withRunGuard(
        'run_x',
        { expectedPattern: 'critic-loop', context: 'critic-loop' },
        body,
      ),
    ).rejects.toThrow('boom');

    expect(mockFinalizeRun).toHaveBeenCalledWith('run_x', 'critic-loop');
  });

  // #95 — fallback partial-outcome on unhandled exception. The guard
  // catches anything the orchestrator body threw, records a finding so
  // status=error runs always carry a board row, then re-throws so the
  // route's existing logging still fires.
  it('records partial-outcome with the error message when body throws', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'debate-judge' }));
    const body = vi
      .fn()
      .mockRejectedValue(new Error('opencode 502 mid-round'));

    await expect(
      withRunGuard(
        'run_test_x',
        { expectedPattern: 'debate-judge', context: 'debate-judge' },
        body,
      ),
    ).rejects.toThrow('opencode 502 mid-round');

    expect(mockRecordPartialOutcome).toHaveBeenCalledTimes(1);
    const [runID, payload] = mockRecordPartialOutcome.mock.calls[0];
    expect(runID).toBe('run_test_x');
    expect(payload.pattern).toBe('debate-judge');
    expect(payload.phase).toBe('debate-judge (unhandled-exception)');
    expect(payload.reason).toContain('opencode 502');
    expect(payload.summary).toContain('opencode 502 mid-round');
  });

  it('does NOT record partial-outcome when body resolves cleanly', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'council' }));
    const body = vi.fn().mockResolvedValue(undefined);

    await withRunGuard(
      'run_x',
      { expectedPattern: 'council', context: 'council' },
      body,
    );

    expect(mockRecordPartialOutcome).not.toHaveBeenCalled();
    expect(mockFinalizeRun).toHaveBeenCalledOnce();
  });

  it('still re-throws even if recordPartialOutcome itself throws', async () => {
    // Belt-and-braces: a failure in the recording path shouldn't
    // swallow the original error. The route's catch needs to see
    // the actual exception, not a meta-error from the fallback.
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'map-reduce' }));
    mockRecordPartialOutcome.mockImplementation(() => {
      throw new Error('record-failed');
    });
    const body = vi.fn().mockRejectedValue(new Error('original-error'));

    await expect(
      withRunGuard(
        'run_x',
        { expectedPattern: 'map-reduce', context: 'map-reduce' },
        body,
      ),
    ).rejects.toThrow('original-error');
  });

  it('forwards body return value when it returns a value', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'map-reduce' }));
    const body = vi.fn().mockResolvedValue('ok');

    const out = await withRunGuard(
      'run_x',
      { expectedPattern: 'map-reduce', context: 'map-reduce' },
      body,
    );

    expect(out).toBe('ok');
  });
});
