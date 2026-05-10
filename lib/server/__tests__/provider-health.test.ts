import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock config before importing the module
vi.mock('../config', () => ({
  OLLAMA_URL: 'http://localhost:11434',
}));

// Mock the server-only guard so vitest can import the module
vi.mock('server-only', () => ({}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('provider-health', () => {
  let probeOllamaPs: () => Promise<{ ok: boolean; detail?: string }>;
  let probeProviders: () => Promise<{ ok: boolean; detail?: string }>;
  let invalidateProviderHealthCache: () => void;

  beforeEach(async () => {
    mockFetch.mockReset();
    // Dynamic import to get fresh module after mocks are in place
    const mod = await import('../provider-health');
    probeOllamaPs = mod.probeOllamaPs;
    probeProviders = mod.probeProviders;
    invalidateProviderHealthCache = mod.invalidateProviderHealthCache;
    invalidateProviderHealthCache();
  });

  describe('probeOllamaPs', () => {
    it('returns ok=true when ollama responds with 200', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const result = await probeOllamaPs();
      expect(result.ok).toBe(true);
    });

    it('returns ok=false with HTTP status when ollama responds with non-200', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      const result = await probeOllamaPs();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('503');
    });

    it('returns ok=false with error message when fetch throws', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await probeOllamaPs();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('ECONNREFUSED');
    });
  });

  describe('probeProviders (cached)', () => {
    it('caches a successful result for subsequent calls', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const first = await probeProviders();
      expect(first.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const second = await probeProviders();
      expect(second.ok).toBe(true);
      // No additional fetch — cached within TTL
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('re-probes after cache is invalidated', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      await probeProviders();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      invalidateProviderHealthCache();

      const result = await probeProviders();
      expect(result.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});