
import { describe, expect, it, vi } from 'vitest';
import { runMapReduceSynthesis } from '../map-reduce';
import { withRunGuard } from '../run-guard';
import { tickCoordinator } from '../blackboard/coordinator';
import { getBoardItem, insertBoardItem } from '../blackboard/store';
import { TIMINGS } from '../pattern-tunables';
import { buildMapPhaseSummary } from '../map-reduce/parsers';

vi.mock('../run-guard', () => ({
  withRunGuard: vi.fn((id, options, cb) => cb({
    swarmRunID: id,
    sessionIDs: ['ses_1', 'ses_2'],
    directive: 'test',
    workspace: 'ws',
    enableSynthesisCritic: false,
  })),
}));

vi.mock('../blackboard/coordinator', () => ({
  tickCoordinator: vi.fn(),
}));

vi.mock('../blackboard/store', () => ({
  getBoardItem: vi.fn(),
  insertBoardItem: vi.fn(),
}));

vi.mock('../harvest-drafts', () => ({
  snapshotKnownIDs: vi.fn().mockResolvedValue(new Map()),
  harvestDrafts: vi.fn().mockResolvedValue([
    { sessionID: 'ses_1', text: 'draft 1', ok: true },
    { sessionID: 'ses_2', text: 'draft 2', ok: true },
  ]),
}));

vi.mock('../swarm-bounds', () => ({
  checkWallClockExpired: vi.fn().mockReturnValue(false),
}));

vi.mock('../degraded-completion', () => ({
  recordPartialOutcome: vi.fn(),
}));

describe('runMapReduceSynthesis dispatch deadline', () => {
  it('records a partial outcome when the dispatch deadline is exceeded', async () => {
    const swarmRunID = 'run_123';
    const itemID = `synth_${swarmRunID}`;

    // Simulate: item is not yet claimed by any session
    (getBoardItem as any).mockReturnValue(undefined);
    (insertBoardItem as any).mockImplementation(() => {});
    
    // tickCoordinator always returns 'skipped' (no one claims the synthesis item)
    (tickCoordinator as any).mockResolvedValue({
      status: 'skipped',
      reason: 'no-claimable-work',
    });

    // To speed up the test, we can mock Date.now or just wait. 
    // But we use a small timeout in actual code. 
    // Let's mock Date.now to fast-forward.
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    // First tick runs normally, second tick fast-forwards Date.now past
    // the dispatch deadline so the while-loop exits on the next check.
    let callCount = 0;
    (tickCoordinator as any).mockImplementation(async () => {
      callCount += 1;
      if (callCount >= 2) {
        now += TIMINGS.mapReduce.dispatchDeadlineMs + 1;
      }
      return { status: 'skipped', reason: 'no-claimable-work' };
    });

    await runMapReduceSynthesis(swarmRunID);

    const { recordPartialOutcome } = await import('../degraded-completion');
    expect(recordPartialOutcome).toHaveBeenCalledWith(swarmRunID, expect.objectContaining({
      phase: 'synthesis-dispatch-deadline',
      reason: 'deadline-exceeded',
    }));
  });
});
