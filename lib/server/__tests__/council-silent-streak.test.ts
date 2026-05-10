import { describe, expect, it, vi } from 'vitest';
import { runCouncilRounds } from '../council';
import { harvestDrafts } from '../harvest-drafts';
import { recordPartialOutcome } from '../degraded-completion';
import { withRunGuard } from '../run-guard';

vi.mock('../harvest-drafts');
vi.mock('../degraded-completion');
vi.mock('../run-guard');
vi.mock('../opencode-server', () => ({
  getSessionMessagesServer: vi.fn(),
  postSessionMessageServer: vi.fn(),
  abortSessionServer: vi.fn(),
}));
vi.mock('../blackboard/coordinator');

describe('council silent-streak degradation', () => {
  it('tracks silent sessions and aborts when <2 active members remain', async () => {
    const swarmRunID = 'test-run';
    const meta = {
      swarmRunID,
      sessionIDs: ['s1', 's2', 's3', 's4', 's5'],
      workspace: '/tmp',
      teamModels: [],
      autoStopOnConverge: false,
      directive: 'do something',
    };

    // Mock withRunGuard to just execute the callback
    (withRunGuard as any).mockImplementation(async (id: string, _opts: any, cb: (m: any) => Promise<any>) => await cb(meta));

    //- Round 2: s1, s2, s3 produce text; s4, s5 are silent.
    (harvestDrafts as any).mockResolvedValueOnce([
      { sessionID: 's1', text: 'T1', ok: true, newKnownIDs: new Set([]) },
      { sessionID: 's2', text: 'T2', ok: true, newKnownIDs: new Set([]) },
      { sessionID: 's3', text: 'T3', ok: true, newKnownIDs: new Set([]) },
      { sessionID: 's4', text: null, ok: false, reason: 'silent', newKnownIDs: new Set([]) },
      { sessionID: 's5', text: null, ok: false, reason: 'silent', newKnownIDs: new Set([]) },
    ]);

    //- Round 3: s1, s2 produce text; s3 becomes silent. (S4, S5 already excluded)
    (harvestDrafts as any).mockResolvedValueOnce([
      { sessionID: 's1', text: 'T1-rev', ok: true, newKnownIDs: new Set([]) },
      { sessionID: 's2', text: 'T2-rev', ok: true, newKnownIDs: new Set([]) },
      { sessionID: 's3', text: null, ok: false, reason: 'silent', newKnownIDs: new Set([]) },
      { sessionID: 's4', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
      { sessionID: 's5', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
    ]);

    //- Round 4: s1 producing text; s2 becomes silent. (S3, S4, S5 already excluded)
    (harvestDrafts as any).mockResolvedValueOnce([
      { sessionID: 's1', text: 'T1-final', ok: true, newKnownIDs: new Set([]) },
      { sessionID: 's2', text: null, ok: false, reason: 'silent', newKnownIDs: new Set([]) },
      { sessionID: 's3', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
      { sessionID: 's4', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
      { sessionID: 's5', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
    ]);

    //- Round 5: all members silent.
    (harvestDrafts as any).mockResolvedValueOnce([
      { sessionID: 's1', text: null, ok: false, reason: 'silent', newKnownIDs: new Set([]) },
      { sessionID: 's2', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
      { sessionID: 's3', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
      { sessionID: 's4', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
      { sessionID: 's5', text: null, ok: false, reason: 'excluded', newKnownIDs: new Set([]) },
    ]);

    await runCouncilRounds(swarmRunID, { maxRounds: 5 });

    // Verify excludeSessions was passed starting from Round 3
    const calls = (harvestDrafts as any).mock.calls;
    
    // Round 2: first call, no excludes
    expect(calls[0][1].excludeSessions).toBeUndefined();
    
    // Round 3: should exclude s4, s5
    expect(calls[1][1].excludeSessions).toEqual(expect.arrayContaining(['s4', 's5']));
    
    // Round 4: should exclude s3, s4, s5
    expect(calls[2][1].excludeSessions).toEqual(expect.arrayContaining(['s3', 's4', 's5']));
    
    // Round 5: should exclude s2, s3, s4, s5
    expect(calls[3][1].excludeSessions).toEqual(expect.arrayContaining(['s2', 's3', 's4', 's5']));

    // Verify final abort with partial outcome
    expect(recordPartialOutcome).toHaveBeenCalledWith(
      swarmRunID,
      expect.objectContaining({
        reason: 'all-sessions-silent',
      })
    );
  });
});
