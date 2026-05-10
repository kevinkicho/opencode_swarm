import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Must mock all transitive deps of state.ts before the dynamic import.
// state.ts imports: swarm-registry, opencode-server, demo-log-retention,
// ticker-snapshots, coordinator (type-only), and ./types.
vi.mock('../../swarm-registry', () => ({
  getRun: vi.fn(),
  listRuns: vi.fn().mockResolvedValue([]),
  deriveRunRow: vi.fn(),
}));

vi.mock('../../opencode-server', () => ({
  abortSessionServer: vi.fn(),
}));

vi.mock('../../demo-log-retention', () => ({
  pruneDemoLog: vi.fn().mockResolvedValue({ scanned: 0, compressed: 0, deleted: 0, errors: 0 }),
}));

vi.mock('../ticker-snapshots', () => ({
  readTickerSnapshot: vi.fn().mockReturnValue(null),
}));

describe('auto-ticker state', () => {
  let tickers: Function;
  let replaceTickerSession: Function;
  let snapshot: Function;
  let classifyMetaForCleanup: Function;

  beforeAll(async () => {
    const mod = await import('../state');
    tickers = mod.tickers;
    replaceTickerSession = mod.replaceTickerSession;
    snapshot = mod.snapshot;
    classifyMetaForCleanup = mod.classifyMetaForCleanup;
  });

  beforeEach(() => {
    const map = tickers();
    for (const key of map.keys()) map.delete(key);
  });

  it('tickers() returns a Map', () => {
    const t = tickers();
    expect(t).toBeInstanceOf(Map);
  });

  it('tickers() returns the same Map on subsequent calls', () => {
    expect(tickers()).toBe(tickers());
  });

  it('replaceTickerSession returns false for unknown run', () => {
    expect(replaceTickerSession('unknown', 'old', 'new')).toBe(false);
  });

  it('snapshot returns expected shape for empty state', () => {
    const state = {
      swarmRunID: 'test',
      intervalMs: 10000,
      timer: null,
      stopped: false,
      sessionIDs: ['ses_a'],
      slots: new Map([['ses_a', { sessionID: 'ses_a', inFlight: false, consecutiveIdle: 0 }]]),
      startedAtMs: Date.now(),
      totalCommits: 0,
      periodicSweepMs: 0,
      orchestratorSessionID: '',
      currentTier: 1,
      consecutiveNoClaimableWork: 0,
      resweepInFlight: false,
    };
    const snap = snapshot(state);
    expect(snap.swarmRunID).toBe('test');
    expect(snap.inFlight).toBe(false);
    expect(snap.totalCommits).toBe(0);
  });

  describe('classifyMetaForCleanup', () => {
    it('exists as an exported function', () => {
      expect(typeof classifyMetaForCleanup).toBe('function');
    });

    it('handles async classification gracefully', async () => {
      const meta = {
        swarmRunID: 'run_test',
        createdAt: Date.now() - 60 * 60 * 1000,
        sessionIDs: [],
      };
      // deriveRunRow is mocked to return undefined, so the try/catch path should work
      const result = await classifyMetaForCleanup(meta);
      expect(typeof result).toBe('string');
    });
  });
});
