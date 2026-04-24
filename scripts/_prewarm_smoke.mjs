#!/usr/bin/env node
// Pre-warm smoke (2026-04-24). Live probe — calls prewarmModels against
// the 3 ollama-tier models we use, then measures follow-up-prompt
// latency to confirm warmup actually worked.
//
// This isn't a unit test; it hits a real ollama daemon. Skip by setting
// PREWARM_SMOKE_SKIP=1. Baseline expectations (from 2026-04-24 probes):
//   cold glm-5.1:cloud:        ~49s first-token
//   cold gemma4:31b-cloud:     <1s first-token once loaded
//   cold nemotron-3-super:     ~65s first-token
// After prewarm, ALL three should return <5s. If nemotron still takes
// >10s post-prewarm, ollama cloud may be evicting models per-call —
// fall back to swapping nemotron out of pattern defaults.
//
// Run:
//   OLLAMA_URL=http://172.24.32.1:11434 npx tsx scripts/_prewarm_smoke.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';

if (process.env.PREWARM_SMOKE_SKIP) {
  console.log('PREWARM_SMOKE_SKIP set — skipping.');
  process.exit(0);
}

const prewarmPath = pathToFileURL(
  path.resolve('lib/server/blackboard/model-prewarm.ts'),
).href;
const { prewarmModels } = await import(prewarmPath);

const base = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const models = [
  'ollama/glm-5.1:cloud',
  'ollama/gemma4:31b-cloud',
  'ollama/nemotron-3-super:cloud',
];

async function timeGenerate(model) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'reply with exactly: ok',
        stream: false,
        options: { num_predict: 3 },
      }),
      signal: ac.signal,
    });
    const elapsed = Date.now() - started;
    if (!res.ok) {
      return { ok: false, elapsed, err: `HTTP ${res.status}` };
    }
    await res.text();
    return { ok: true, elapsed };
  } catch (err) {
    return {
      ok: false,
      elapsed: Date.now() - started,
      err: ac.signal.aborted ? 'aborted (>90s)' : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`=== prewarm smoke · target ${base} ===`);
console.log();
console.log('Step 1: prewarm all 3 models in parallel');
const warmStart = Date.now();
const warmResults = await prewarmModels(models);
console.log(`prewarm total wall-clock: ${Math.round((Date.now() - warmStart) / 1000)}s`);
for (const r of warmResults) {
  console.log(`  ${r.ok ? '✓' : '✗'}  ${r.modelId}  ${(r.elapsedMs / 1000).toFixed(1)}s  ${r.error ?? ''}`);
}
console.log();
console.log('Step 2: follow-up prompt to each model (should be fast if warm)');

let allFast = true;
for (const m of models) {
  const bareName = m.replace(/^ollama\//, '');
  const r = await timeGenerate(bareName);
  const elapsed = (r.elapsed / 1000).toFixed(1);
  const verdict = r.ok && r.elapsed < 10_000 ? '✓ FAST' : r.ok ? '⚠ slow' : '✗ FAIL';
  if (!r.ok || r.elapsed >= 10_000) allFast = false;
  console.log(`  ${verdict}  ${m}  ${elapsed}s  ${r.err ?? ''}`);
}
console.log();

if (allFast) {
  console.log('PASS — all follow-ups under 10s post-prewarm.');
  process.exit(0);
} else {
  console.log('PARTIAL — some models slow or failed. Review output above.');
  console.log('  If nemotron consistently >10s post-prewarm, ollama cloud may');
  console.log('  be evicting models between calls; fall back to swapping nemotron');
  console.log('  out of pattern defaults.');
  process.exit(1);
}
