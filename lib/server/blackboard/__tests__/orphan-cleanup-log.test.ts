// HARDENING_PLAN.md#R3 — orphan cleanup forensic log.
//
// Pre-fix the catch at lib/server/blackboard/auto-ticker/state.ts:82
// was empty: a transient opencode hiccup during startup orphan-cleanup
// would silently kill a live run with no log line.
//
// The fix adds a console.warn so the operator can grep dev logs and see
// which runs got reaped and why. This test exercises the extracted
// classifyMetaForCleanup helper directly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const opencodeMocks = vi.hoisted(() => ({
  getSessionMessagesServer: vi.fn(),
  abortSessionServer: vi.fn(),
  postSessionMessageServer: vi.fn(),
}));
vi.mock('../../opencode-server', () => opencodeMocks);

vi.mock('../../swarm-registry', () => ({
  deriveRunRow: vi.fn(),
}));

const { deriveRunRow } = await import('../../swarm-registry');
const { classifyMetaForCleanup } = await import('../auto-ticker/state');

import { fakeMeta } from '../../__tests__/_helpers/fake-meta';

const mockDeriveRunRow = vi.mocked(deriveRunRow);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockDeriveRunRow.mockReset();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('classifyMetaForCleanup (R3)', () => {
  it('returns alive when deriveRunRow reports recent activity', async () => {
    const now = Date.now();
    const meta = fakeMeta({ swarmRunID: 'run_active' });
    mockDeriveRunRow.mockResolvedValue({
      lastActivityTs: now - 60_000, // 1 min ago — well within RECENT_ACTIVITY_MS (5 min)
    } as Awaited<ReturnType<typeof deriveRunRow>>);

    const verdict = await classifyMetaForCleanup(meta, now);
    expect(verdict).toBe('alive');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns orphan when deriveRunRow reports stale activity', async () => {
    const now = Date.now();
    const meta = fakeMeta({ swarmRunID: 'run_stale' });
    mockDeriveRunRow.mockResolvedValue({
      lastActivityTs: now - 30 * 60_000, // 30 min ago — way past 5 min cutoff
    } as Awaited<ReturnType<typeof deriveRunRow>>);

    const verdict = await classifyMetaForCleanup(meta, now);
    expect(verdict).toBe('orphan');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns orphan AND emits forensic warn when deriveRunRow throws', async () => {
    const meta = fakeMeta({ swarmRunID: 'run_failing' });
    mockDeriveRunRow.mockRejectedValue(new Error('opencode 502 unreachable'));

    const verdict = await classifyMetaForCleanup(meta);
    expect(verdict).toBe('orphan');

    // The forensic log is the whole point of R3.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, reason] = warnSpy.mock.calls[0];
    expect(msg).toContain('[board/auto-ticker] orphan-cleanup');
    expect(msg).toContain('run_failing');
    expect(msg).toContain('deriveRunRow threw');
    expect(reason).toBe('opencode 502 unreachable');
  });

  it('preserves orphan behavior even when error is a non-Error value', async () => {
    const meta = fakeMeta({ swarmRunID: 'run_weird_error' });
    mockDeriveRunRow.mockRejectedValue('string-not-error');

    const verdict = await classifyMetaForCleanup(meta);
    expect(verdict).toBe('orphan');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, reason] = warnSpy.mock.calls[0];
    expect(reason).toBe('string-not-error');
  });

  it('falls back to meta.createdAt when lastActivityTs is missing', async () => {
    const now = Date.now();
    const recentMeta = fakeMeta({
      swarmRunID: 'run_no_activity_recent',
      createdAt: now - 60_000, // recent createdAt
    });
    mockDeriveRunRow.mockResolvedValue({
      // lastActivityTs intentionally absent
    } as Awaited<ReturnType<typeof deriveRunRow>>);

    const verdict = await classifyMetaForCleanup(recentMeta, now);
    expect(verdict).toBe('alive');
  });
});
