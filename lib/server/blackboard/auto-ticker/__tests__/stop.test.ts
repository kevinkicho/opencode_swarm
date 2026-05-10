import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock all transitive dependencies of stop.ts before dynamic import.
// stop.ts statically imports: opencode-server, swarm-registry,
// swarm-registry/derive, bus, ticker-snapshots, audit, state (partially
// mocked), degraded-completion, and store.
vi.mock('../../opencode-server', () => ({
  abortSessionServer: vi.fn(),
}));

vi.mock('../../swarm-registry', () => ({
  getRun: vi.fn(),
}));

vi.mock('../../swarm-registry/derive', () => ({
  invalidateDerivedRow: vi.fn(),
}));

vi.mock('../bus', () => ({
  emitTickerTick: vi.fn(),
}));

vi.mock('../ticker-snapshots', () => ({
  persistTickerSnapshot: vi.fn(),
}));

vi.mock('./audit', () => ({
  maybeRunAudit: vi.fn(),
}));

vi.mock('../../degraded-completion', () => ({
  recordPartialOutcome: vi.fn(),
}));

vi.mock('../store', () => ({
  listBoardItems: vi.fn().mockReturnValue([]),
}));

// state.ts also needs its transitive deps mocked since we pass through
// to the original. Without these, tickers() startup cleanup tries to
// call pruneDemoLog → real config → process.env, which is fine but
// makes the test non-isolated from filesystem.
vi.mock('../../demo-log-retention', () => ({
  pruneDemoLog: vi.fn().mockResolvedValue({ scanned: 0, compressed: 0, deleted: 0, errors: 0 }),
}));

// Partial mock of state — pass through real exports but intercept
// the tickers Map so tests can control it.
vi.mock('../state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state')>();
  return { ...actual };
});

describe('stopAutoTicker', () => {
  let stopAutoTicker: Function;
  let tickers: () => Map<string, unknown>;

  beforeAll(async () => {
    const mod = await import('../stop');
    stopAutoTicker = mod.stopAutoTicker;
    const stateMod = await import('../state');
    tickers = stateMod.tickers;
  });

  beforeEach(() => {
    const map = tickers();
    for (const key of map.keys()) map.delete(key);
  });

  it('air-imports module as a function', () => {
    expect(typeof stopAutoTicker).toBe('function');
  });

  it('no-ops for unknown swarmRunID (no ticker entry)', () => {
    expect(() => stopAutoTicker('unknown', 'manual')).not.toThrow();
  });

  it('no-ops when ticker already stopped', () => {
    const map = tickers();
    map.set('run_test', {
      swarmRunID: 'run_test',
      stopped: true,
      timer: null,
      periodicSweepTimer: null,
      livenessTimer: null,
      sessionIDs: [],
      slots: new Map(),
    });
    expect(() => stopAutoTicker('run_test', 'manual')).not.toThrow();
  });

  it('stops a live ticker and records stop metadata', () => {
    const map = tickers();
    // TickerState has many fields — constructing a full typed object
    // here is brittle. Cast via unknown so stopAutoTicker can mutate
    // stopReason/stoppedAtMs at runtime.
    const state = {
      swarmRunID: 'run_test',
      intervalMs: 10000,
      stopped: false,
      timer: null,
      periodicSweepTimer: null,
      livenessTimer: null,
      sessionIDs: ['ses_a'],
      slots: new Map(),
      startedAtMs: Date.now(),
      totalCommits: 0,
      periodicSweepMs: 0,
      orchestratorSessionID: '',
      currentTier: 1,
      consecutiveNoClaimableWork: 0,
      resweepInFlight: false,
      commitsSinceLastAudit: 0,
      auditInFlight: false,
      auditEveryNCommits: 3,
      lastSweepAtMs: 0,
      lastSeenTokens: 0,
      lastTokensChangedAtMs: Date.now(),
      consecutiveFilteredAllTodos: 0,
      plannerErrors: 0,
    } as unknown as Record<string, unknown>;
    map.set('run_test', state);

    stopAutoTicker('run_test', 'manual');

    expect(state.stopped).toBe(true);
    expect(state.stopReason).toBe('manual');
    expect(state.stoppedAtMs).toBeGreaterThan(0);
  });
});
