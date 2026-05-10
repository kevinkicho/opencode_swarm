import { describe, expect, it, vi } from 'vitest';
import { runSynthesisCriticGate } from '../map-reduce';
import { getSessionMessagesServer, postSessionMessageServer } from '../opencode-server';
import { waitForSessionIdle } from '../blackboard/coordinator';
import { parseCriticVerdict } from '../map-reduce/parsers';

vi.mock('../opencode-server', () => ({
  getSessionMessagesServer: vi.fn(),
  postSessionMessageServer: vi.fn(),
}));

vi.mock('../blackboard/coordinator', () => ({
  waitForSessionIdle: vi.fn(),
}));

describe('runSynthesisCriticGate model selection', () => {
  it('passes the correct model from teamModels when synthesisModel is unset during revision', async () => {
    const meta = {
      swarmRunID: 'run-123',
      workspace: 'ws-1',
      sessionIDs: ['s1', 's2'],
      teamModels: ['model-A', 'model-B'],
      synthesisModel: undefined,
      enableSynthesisCritic: true,
    } as any;

    const drafts = [{ sessionID: 's1', text: 'd1' }, { sessionID: 's2', text: 'd2' }];
    const synthesizerSessionID = 's1'; // Index 0 -> model-A
    const criticSessionID = 's2';        // Index 1 -> model-B

    // 1. Mock synthesizer output
    (getSessionMessagesServer as any).mockResolvedValueOnce([
      { info: { id: 'm1' }, role: 'assistant', content: 'Synthesis text' },
    ]);

    // 2. Mock critic's before-state
    (getSessionMessagesServer as any).mockResolvedValueOnce([]);

    // 3. Mock critic output to trigger REVISE
    (waitForSessionIdle as any).mockResolvedValueOnce({ ok: true });
     (getSessionMessagesServer as any).mockResolvedValueOnce([
       {
         info: { id: 'm2' },
         role: 'assistant',
         content: 'REVISE\nFix the bug.',
         parts: [{ type: 'text', text: 'REVISE\nFix the bug.' }],
       },
     ]);

     // 4. Mock synthesizer's before-state for the revision phase
     (getSessionMessagesServer as any).mockResolvedValueOnce([
       {
         info: { id: 'm1' },
         role: 'assistant',
         content: 'Synthesis text',
         parts: [{ type: 'text', text: 'Synthesis text' }],
       },
     ]);

    // 5. Mock synthesizer's revision wait
    (waitForSessionIdle as any).mockResolvedValueOnce({ ok: true });

    await runSynthesisCriticGate(meta, drafts, synthesizerSessionID);

    // Verify the final call (revision post) uses model-A from teamModels[0]
    const revisionCall = (postSessionMessageServer as any).mock.calls.find(
      (call: any) => call[0] === synthesizerSessionID
    );
    
    expect(revisionCall[3]).toEqual({ model: 'model-A' });
  });
});
