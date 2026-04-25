import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock uses literal-string path matching, so the mock path must
// match the import path inside `opencode-server.ts` (which imports
// from `'../opencode/client'`). Resolved-from-this-test that's
// `'../../opencode/client'`.
vi.mock('../../opencode/client', () => ({
  opencodeFetch: vi.fn(),
}));

// We also need to short-circuit the F7 prompt-preflight path inside
// postSessionMessageServer — it calls getSessionMessagesServer which
// (via opencodeFetch) would otherwise try a real network call. The
// mock above covers it; we just need a default that returns an empty
// message array so shape validation doesn't throw.

const { postSessionMessageServer } = await import('../opencode-server');
const { opencodeFetch } = await import('../../opencode/client');
const mockFetch = vi.mocked(opencodeFetch);

beforeEach(() => {
  mockFetch.mockReset();
  // Default: return an empty array (passes shape validation for the
  // /message endpoint preflight) and behaves as success for the
  // prompt_async POST.
  mockFetch.mockResolvedValue({
    ok: true,
    text: async () => '',
    json: async () => [],
  } as unknown as Response);
});

describe('team-models pinning smoke test', () => {
  const mockWorkspace = '/work';
  const mockSessionId = 'sid_123';
  const mockModel = 'ollama/gemma4:31b-cloud';

  it('pins the requested model when teamModels is populated', async () => {
    await postSessionMessageServer(mockSessionId, mockWorkspace, 'hello', {
      model: mockModel,
    });
    // Last call should be the prompt_async POST. Body should serialize
    // the {providerID, modelID} object form, not a bare string.
    const calls = mockFetch.mock.calls;
    const promptCall = calls.find(([url]) =>
      typeof url === 'string' && url.includes('prompt_async'),
    );
    expect(promptCall).toBeDefined();
    const body = JSON.parse(promptCall![1]!.body as string);
    expect(body.model).toEqual({
      providerID: 'ollama',
      modelID: 'gemma4:31b-cloud',
    });
  });

  it('does not pin a model when model is omitted', async () => {
    await postSessionMessageServer(mockSessionId, mockWorkspace, 'hello');
    const calls = mockFetch.mock.calls;
    const promptCall = calls.find(([url]) =>
      typeof url === 'string' && url.includes('prompt_async'),
    );
    expect(promptCall).toBeDefined();
    const body = JSON.parse(promptCall![1]!.body as string);
    expect(body.model).toBeUndefined();
  });
});
