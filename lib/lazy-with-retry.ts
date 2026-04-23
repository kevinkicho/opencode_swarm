// Retry wrapper for next/dynamic loaders. In dev, webpack chunk fetches can
// race with HMR recompiles: the browser asks for a chunk by a hash that the
// server has already rotated, webpack throws `ChunkLoadError: Loading chunk
// ... failed`, and the component never mounts. One retry after a short delay
// almost always succeeds because the fresh hash has propagated by then.
//
// Scope: only retries the specific chunk-load failure. Any other rejection
// (import error, network down, syntax error) rethrows immediately so real
// bugs don't get swallowed by a retry loop.

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    if (e.name === 'ChunkLoadError') return true;
    if (typeof e.message === 'string' && /Loading chunk .* failed/.test(e.message)) return true;
  }
  return false;
}

export function lazyWithRetry<T>(
  importFn: () => Promise<T>,
  retries = 4,
  baseDelayMs = 500,
): () => Promise<T> {
  return async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await importFn();
      } catch (err) {
        lastErr = err;
        if (!isChunkLoadError(err)) throw err;
        if (attempt === retries) break;
        const delay = baseDelayMs * Math.pow(2, attempt);
        // Loud enough to notice when the dev server is chunk-starved,
        // quiet enough not to spam in normal runs (each retry is rare).
        console.info(
          `[lazy-with-retry] ChunkLoadError on attempt ${attempt + 1}/${retries + 1}, retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  };
}
