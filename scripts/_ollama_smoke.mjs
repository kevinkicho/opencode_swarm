#!/usr/bin/env node
// Ollama tier smoke: asserts the code-level invariants of the three-
// tier reversal (2026-04-24). None of these require a live opencode —
// they validate the Next.js layer's routing + pricing + catalog shape.
// End-to-end dispatch validation lives in docs/VALIDATION.md.
//
// Run with: npx tsx scripts/_ollama_smoke.mjs
// Exits 0 on pass, 1 on any assertion failure.

import { pathToFileURL } from 'node:url';
import path from 'node:path';

const transformPath = pathToFileURL(
  path.resolve('lib/opencode/transform.ts'),
).href;
const pricingPath = pathToFileURL(
  path.resolve('lib/opencode/pricing.ts'),
).href;
const modelCatalogPath = pathToFileURL(
  path.resolve('lib/model-catalog.ts'),
).href;
const zenCatalogPath = pathToFileURL(
  path.resolve('lib/zen-catalog.ts'),
).href;

// transform.ts's providerOf + familyOf are module-private — test via
// __test_exports when available, otherwise grep-verify their shape.
// For this smoke we hit the exported surface that downstream consumers
// use.
const { priceFor } = await import(pricingPath);
const { modelCatalog } = await import(modelCatalogPath);
const { zenModels, familyMeta } = await import(zenCatalogPath);

let passed = 0;
let failed = 0;
const failures = [];

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL [${label}]\n  expected: ${e}\n  actual:   ${a}`);
}

function assert(cond, label) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`FAIL [${label}]`);
}

// ── The 5 canonical ollama model IDs we shipped ───────────────────────

const OLLAMA_IDS = [
  'ollama/nemotron-3-super:cloud',
  'ollama/gemma4:31b-cloud',
  'ollama/kimi-k2.6:cloud',
  'ollama/glm-5.1:cloud',
  'ollama/mistral-large-3:675b-cloud',
];

// ── Pricing: the load-bearing invariant ──────────────────────────────
// Subscription-billed means per-token = 0. Critical: `ollama/kimi-k2.6:cloud`
// must NOT hit the zen `kimi-k2-6` row and get charged $0.95/M input +
// $4/M output. `ollama/glm-5.1:cloud` must NOT hit the zen `glm-5-1`
// row at $1.4/$4.4. The LOOKUP reorder (ollama pattern first) is the
// guard; this test locks it in.

for (const id of OLLAMA_IDS) {
  const price = priceFor(id);
  assert(price !== undefined, `priceFor resolves: ${id}`);
  if (price) {
    eq(
      { input: price.input, output: price.output, cached: price.cached },
      { input: 0, output: 0, cached: 0 },
      `priceFor returns 0 for subscription-billed: ${id}`,
    );
  }
}

// Regression guards — zen/go models keep their pricing (nothing got
// accidentally zero'd by the reorder).
{
  const claudeOpus = priceFor('claude-opus-4-7');
  assert(claudeOpus && claudeOpus.input === 5 && claudeOpus.output === 25, 'zen claude-opus-4-7 pricing intact');

  const zenKimi = priceFor('kimi-k2-6');
  assert(zenKimi && zenKimi.input === 0.95, 'zen kimi-k2-6 pricing intact (not zen-zeroed by ollama reorder)');

  const zenGlm51 = priceFor('glm-5-1');
  assert(zenGlm51 && zenGlm51.input === 1.4, 'zen glm-5-1 pricing intact');
}

// Accidental match test: a zen ID that contains `ollama` substring
// should still hit the ollama catchall (expected) — this isn't a bug,
// it's the defensive behavior. A zen ID containing `kimi` but not
// `ollama` still gets charged.
{
  const accidentalZenKimi = priceFor('kimi-k2.6');
  assert(accidentalZenKimi && accidentalZenKimi.input > 0, 'bare kimi-k2.6 (no ollama prefix) still charged');
}

// ── model-catalog.ts: all 5 ollama entries present with correct shape ─

for (const id of OLLAMA_IDS) {
  const entry = modelCatalog.find((m) => m.id === id);
  assert(entry, `modelCatalog has entry: ${id}`);
  if (entry) {
    eq(entry.provider, 'ollama', `modelCatalog entry has provider='ollama': ${id}`);
    eq(entry.limitTag, 'ollama max', `modelCatalog entry has limitTag='ollama max': ${id}`);
    assert(
      entry.pricing.input === 0 && entry.pricing.output === 0,
      `modelCatalog entry has 0 pricing: ${id}`,
    );
  }
}

// Family coverage for the 5 models (added nemotron/gemma/mistral +
// keep kimi/glm).
{
  const families = OLLAMA_IDS.map((id) => modelCatalog.find((m) => m.id === id)?.family);
  eq(families, ['nemotron', 'gemma', 'kimi', 'glm', 'mistral'], 'modelCatalog families cover all 5 vendors');
}

// ── zen-catalog.ts: all 5 ollama entries present (modal picker feed) ──

for (const id of OLLAMA_IDS) {
  const entry = zenModels.find((m) => m.id === id);
  assert(entry, `zenModels has entry (modal picker): ${id}`);
  if (entry) {
    eq(entry.family, 'ollama', `zenModels entry tagged family='ollama': ${id}`);
    assert(entry.in === 0 && entry.out === 0, `zenModels entry has 0 in/out: ${id}`);
  }
}

// familyMeta['ollama'] must exist so the picker can render the ollama
// group without runtime error.
assert(familyMeta.ollama, "familyMeta has 'ollama' entry");
if (familyMeta.ollama) {
  eq(familyMeta.ollama.label, 'ollama max', 'familyMeta.ollama.label = "ollama max"');
  assert(familyMeta.ollama.color.startsWith('text-'), 'familyMeta.ollama.color is a tailwind text- class');
}

// ── Sanity: total catalog sizes ───────────────────────────────────────

assert(modelCatalog.length >= 5, 'modelCatalog has at least 5 ollama entries on top of existing');
assert(zenModels.length >= 5, 'zenModels has at least 5 ollama entries on top of existing');

// ── Report ────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(failures.join('\n'));
  console.error('');
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
