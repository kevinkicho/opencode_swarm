// Ollama model pre-warm (2026-04-24). Fires a tiny `/api/generate`
// against each unique ollama model in a run's team+gate composition so
// the model is warm on ollama's side by the time opencode's first
// `/prompt_async` arrives.
//
// Why this exists: ollama cloud models have material cold-start latency.
// Empirical: nemotron-3-super:cloud took ~65 s from cold to first-token
// via /api/generate; opencode's /prompt client gave up before the first
// token arrived, so every session pinned to nemotron hung with zero
// assistant output. Pre-warming collapses follow-up latency to ~1-2 s.
//
// Contract:
//   - Only ollama models are warmed (IDs starting with `ollama/`). Other
//     providers (opencode-go, zen) don't have the cold-start issue.
//   - Each model is warmed once per call, deduplicated by ID.
//   - Uses Promise.allSettled so one failing warm-up doesn't block the
//     others.
//   - Fire-and-forget-friendly: errors log and continue. Returns when
//     every warm completes (success or failure) so the caller can await.
//   - Per-model deadline is WARMUP_TIMEOUT_MS; longer than cold-start
//     for the slowest known model (nemotron-3-super) with headroom.
//
// Configuration: OLLAMA_URL env var selects the daemon. Defaults to
// `http://localhost:11434` which is correct when Next.js runs on the
// same host as ollama. WSL→Windows setups point it at the Windows host
// IP (see .env.example). Note this is different from opencode.json's
// `baseURL` which is from opencode's POV (always `127.0.0.1:11434`
// because opencode and ollama are co-located on Windows).

import 'server-only';

import { OLLAMA_URL } from '../../config';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const WARMUP_TIMEOUT_MS = 120_000; // 2 min — covers nemotron's ~65s + buffer
const WARMUP_PROMPT = 'hi';

export interface PrewarmResult {
  modelId: string;
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

// Extract the ollama model name from our canonical `ollama/<name>` ID.
// Returns null for non-ollama IDs so the caller can filter them out.
function ollamaModelName(fullId: string): string | null {
  if (!fullId.startsWith('ollama/')) return null;
  const name = fullId.slice('ollama/'.length).trim();
  return name.length > 0 ? name : null;
}

export async function prewarmModels(
  modelIds: readonly string[],
): Promise<PrewarmResult[]> {
  const base = OLLAMA_URL.replace(/\/$/, '');
  const unique = Array.from(
    new Set(
      modelIds
        .map((id) => ollamaModelName(id))
        .filter((n): n is string => n !== null),
    ),
  );
  if (unique.length === 0) return [];

  console.log(
    `[model-prewarm] warming ${unique.length} model(s) via ${base}: ${unique.join(', ')}`,
  );

  const results = await Promise.all(
    unique.map(async (model): Promise<PrewarmResult> => {
      const started = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), WARMUP_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: WARMUP_PROMPT,
            stream: false,
            // num_predict: 1 asks for a single-token response — enough
            // to ensure the model is fully loaded without paying for a
            // verbose reply. ollama warmup is about inference readiness,
            // not output quality.
            options: { num_predict: 1 },
          }),
          signal: ac.signal,
        });
        const elapsedMs = Date.now() - started;
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return {
            modelId: `ollama/${model}`,
            ok: false,
            elapsedMs,
            error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`,
          };
        }
        // Drain the body so the TCP connection closes cleanly — ollama
        // sometimes hangs the stream if we don't consume.
        await res.text().catch(() => undefined);
        return { modelId: `ollama/${model}`, ok: true, elapsedMs };
      } catch (err) {
        const elapsedMs = Date.now() - started;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          modelId: `ollama/${model}`,
          ok: false,
          elapsedMs,
          error: ac.signal.aborted ? `aborted after ${WARMUP_TIMEOUT_MS}ms` : msg,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  for (const r of results) {
    if (r.ok) {
      console.log(
        `[model-prewarm] ${r.modelId}: warm (${Math.round(r.elapsedMs / 100) / 10}s)`,
      );
    } else {
      console.warn(
        `[model-prewarm] ${r.modelId}: FAILED after ${Math.round(r.elapsedMs / 100) / 10}s — ${r.error}. Run will proceed; pattern may hit cold-start latency.`,
      );
    }
  }
  return results;
}

// Convenience: collect every ollama-targeted model from a swarm run's
// request shape into one flat list for prewarmModels. Caller can pass
// its parsed request directly; extras that aren't strings get skipped.
export function collectOllamaModels(req: {
  teamModels?: readonly string[];
  criticModel?: string;
  verifierModel?: string;
  auditorModel?: string;
}): string[] {
  const out: string[] = [];
  if (Array.isArray(req.teamModels)) {
    for (const m of req.teamModels) if (typeof m === 'string') out.push(m);
  }
  for (const k of ['criticModel', 'verifierModel', 'auditorModel'] as const) {
    const v = req[k];
    if (typeof v === 'string') out.push(v);
  }
  return out;
}
