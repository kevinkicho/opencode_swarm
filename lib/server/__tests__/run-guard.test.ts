import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRunGuard } from '../run-guard';
import type { SwarmRunMeta } from '../../swarm-run-types';

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

const { getRun } = await import('../swarm-registry');
const { finalizeRun } = await import('../finalize-run');

const mockGetRun = vi.mocked(getRun);
const mockFinalizeRun = vi.mocked(finalizeRun);

const fakeMeta = (overrides: Partial<SwarmRunMeta> = {}): SwarmRunMeta =>
  ({
    swarmRunID: 'run_test_x',
    pattern: 'critic-loop',
    workspace: '/tmp/x',
    sessionIDs: ['s1', 's2'],
    createdAt: 0,
    title: 't',
    teamModels: [],
    ...overrides,
  }) as SwarmRunMeta;

beforeEach(() => {
  mockGetRun.mockReset();
  mockFinalizeRun.mockReset();
  mockFinalizeRun.mockResolvedValue(undefined);
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

  it('runs body when pattern is in array (council-as-deliberate-execute case)', async () => {
    mockGetRun.mockResolvedValue(fakeMeta({ pattern: 'deliberate-execute' }));
    const body = vi.fn().mockResolvedValue(undefined);

    await withRunGuard(
      'run_x',
      {
        expectedPattern: ['council', 'deliberate-execute'],
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
        expectedPattern: ['council', 'deliberate-execute'],
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
