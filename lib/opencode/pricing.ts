// Opencode zen per-1M-token prices. Source of truth: https://opencode.ai/docs/zen/
// Keep rates in sync; they shift quarterly. Free tiers resolve to zeros.
//
// `go` (subscription bundle) is not listed — its per-token cost is imputed
// from bundle price ÷ usage ceiling at the run level, not per model.

import type { ModelRef } from '../swarm-types';

export interface ZenPrice {
  input: number;    // $/1M tokens
  output: number;   // $/1M tokens
  cached: number;   // $/1M tokens
  write?: number;   // $/1M tokens (anthropic prompt-cache write tier)
}

// Entries keyed by canonical slug. A lookup pattern below maps opencode's
// modelID (which may carry provider prefixes, date stamps, or "-opus-4-7"
// shapes) to these slugs.
const PRICES: Record<string, ZenPrice> = {
  // Anthropic
  'claude-opus-4-7':  { input: 5,  output: 25,  cached: 0.5,  write: 6.25 },
  'claude-opus-4-6':  { input: 5,  output: 25,  cached: 0.5,  write: 6.25 },
  'claude-opus-4-5':  { input: 5,  output: 25,  cached: 0.5,  write: 6.25 },
  'claude-opus-4-1':  { input: 15, output: 75,  cached: 1.5,  write: 18.75 },
  'claude-sonnet-4-6':{ input: 3,  output: 15,  cached: 0.3,  write: 3.75 },
  'claude-sonnet-4-5':{ input: 3,  output: 15,  cached: 0.3,  write: 3.75 },
  'claude-sonnet-4':  { input: 3,  output: 15,  cached: 0.3,  write: 3.75 },
  'claude-haiku-4-5': { input: 1,  output: 5,   cached: 0.1,  write: 1.25 },
  'claude-haiku-3-5': { input: 0.8,output: 4,   cached: 0.08, write: 1.0 },
  // OpenAI
  'gpt-5-4':         { input: 2.5, output: 15,  cached: 0.25 },
  'gpt-5-4-pro':     { input: 30,  output: 180, cached: 30 },
  'gpt-5-4-mini':    { input: 0.75,output: 4.5, cached: 0.075 },
  'gpt-5-4-nano':    { input: 0.2, output: 1.25,cached: 0.02 },
  'gpt-5-3-codex':   { input: 1.75,output: 14,  cached: 0.175 },
  'gpt-5-2':         { input: 1.75,output: 14,  cached: 0.175 },
  'gpt-5-1':         { input: 1.07,output: 8.5, cached: 0.107 },
  'gpt-5-1-codex-max':{input: 1.25,output: 10,  cached: 0.125 },
  'gpt-5-1-codex-mini':{input:0.25,output: 2,   cached: 0.025 },
  'gpt-5':           { input: 1.07,output: 8.5, cached: 0.107 },
  'gpt-5-nano':      { input: 0,   output: 0,   cached: 0 },
  // Google
  'gemini-3-1-pro':  { input: 2,   output: 12,  cached: 0.2 },
  'gemini-3-flash':  { input: 0.5, output: 3,   cached: 0.05 },
  // Alibaba Qwen
  'qwen-3-6-plus':   { input: 0.5, output: 3,   cached: 0.05, write: 0.625 },
  'qwen-3-5-plus':   { input: 0.2, output: 1.2, cached: 0.02, write: 0.25 },
  // MiniMax
  'minimax-m2-7':    { input: 0.3, output: 1.2, cached: 0.06, write: 0.375 },
  'minimax-m2-5':    { input: 0.3, output: 1.2, cached: 0.06, write: 0.375 },
  // Zhipu GLM
  'glm-5-1':         { input: 1.4, output: 4.4, cached: 0.26 },
  'glm-5':           { input: 1,   output: 3.2, cached: 0.2 },
  // Moonshot Kimi
  'kimi-k2-6':       { input: 0.95,output: 4,   cached: 0.16 },
  'kimi-k2-5':       { input: 0.6, output: 3,   cached: 0.1 },
  // Free tiers
  'minimax-m2-5-free':{input: 0,   output: 0,   cached: 0 },
  'nemotron-free':   { input: 0,   output: 0,   cached: 0 },
  'big-pickle':      { input: 0,   output: 0,   cached: 0 },
  // Ollama bundle (ollama.com max monthly plan). Subscription-billed,
  // so per-token cost resolves to 0 and callers that sum tokens×price
  // see ollama as a bundled line in the cost-dashboard — same shape
  // as opencode-go runs. Added 2026-04-24 with the three-tier
  // stance reversal; see DESIGN.md §9.
  'ollama-bundle':   { input: 0,   output: 0,   cached: 0 },
};

// Order matters: more specific patterns first (e.g. `-pro` before the generic
// model match). First regex wins. Patterns run against the lowercased modelID.
//
// Ollama is matched FIRST so an `ollama/kimi-k2.6:cloud` doesn't accidentally
// hit the zen `kimi-k2-6` row and get charged per-token — ollama is a flat
// subscription, and the catch-all 'ollama-bundle' row returns 0.
const LOOKUP: ReadonlyArray<readonly [RegExp, keyof typeof PRICES]> = [
  [/(^|[/_-])ollama([/_-]|$)/, 'ollama-bundle'],
  [/claude[-_/]?opus[-_/]?4[-_/.]?7/, 'claude-opus-4-7'],
  [/claude[-_/]?opus[-_/]?4[-_/.]?6/, 'claude-opus-4-6'],
  [/claude[-_/]?opus[-_/]?4[-_/.]?5/, 'claude-opus-4-5'],
  [/claude[-_/]?opus[-_/]?4[-_/.]?1/, 'claude-opus-4-1'],
  [/claude[-_/]?sonnet[-_/]?4[-_/.]?6/, 'claude-sonnet-4-6'],
  [/claude[-_/]?sonnet[-_/]?4[-_/.]?5/, 'claude-sonnet-4-5'],
  [/claude[-_/]?sonnet[-_/]?4(?!\d)/, 'claude-sonnet-4'],
  [/claude[-_/]?haiku[-_/]?4[-_/.]?5/, 'claude-haiku-4-5'],
  [/claude[-_/]?haiku[-_/]?3[-_/.]?5/, 'claude-haiku-3-5'],
  [/gpt[-_/]?5[-_/.]?4[-_/]?pro/, 'gpt-5-4-pro'],
  [/gpt[-_/]?5[-_/.]?4[-_/]?mini/, 'gpt-5-4-mini'],
  [/gpt[-_/]?5[-_/.]?4[-_/]?nano/, 'gpt-5-4-nano'],
  [/gpt[-_/]?5[-_/.]?4/, 'gpt-5-4'],
  [/gpt[-_/]?5[-_/.]?3[-_/]?codex/, 'gpt-5-3-codex'],
  [/gpt[-_/]?5[-_/.]?2/, 'gpt-5-2'],
  [/gpt[-_/]?5[-_/.]?1[-_/]?codex[-_/]?max/, 'gpt-5-1-codex-max'],
  [/gpt[-_/]?5[-_/.]?1[-_/]?codex[-_/]?mini/, 'gpt-5-1-codex-mini'],
  [/gpt[-_/]?5[-_/.]?1/, 'gpt-5-1'],
  [/gpt[-_/]?5[-_/]?nano/, 'gpt-5-nano'],
  [/gpt[-_/]?5(?!\d)/, 'gpt-5'],
  [/gemini[-_/]?3[-_/.]?1[-_/]?pro/, 'gemini-3-1-pro'],
  [/gemini[-_/]?3[-_/]?flash/, 'gemini-3-flash'],
  [/qwen[-_/]?3[-_/.]?6/, 'qwen-3-6-plus'],
  [/qwen[-_/]?3[-_/.]?5/, 'qwen-3-5-plus'],
  [/minimax[-_/]?m?2[-_/.]?7/, 'minimax-m2-7'],
  [/minimax[-_/]?m?2[-_/.]?5[-_/]?free/, 'minimax-m2-5-free'],
  [/minimax[-_/]?m?2[-_/.]?5/, 'minimax-m2-5'],
  [/glm[-_/]?5[-_/.]?1/, 'glm-5-1'],
  [/glm[-_/]?5/, 'glm-5'],
  [/kimi[-_/]?k?2[-_/.]?6/, 'kimi-k2-6'],
  [/kimi[-_/]?k?2[-_/.]?5/, 'kimi-k2-5'],
  [/nemotron/, 'nemotron-free'],
  [/big[-_/]?pickle/, 'big-pickle'],
];

export function priceFor(modelID: string | undefined): ZenPrice | undefined {
  if (!modelID) return undefined;
  const lower = modelID.toLowerCase();
  for (const [pattern, key] of LOOKUP) {
    if (pattern.test(lower)) return PRICES[key];
  }
  return undefined;
}

// Output tokens that budgetUSD buys at this model's rate. Uses output price
// since output dominates cost for codegen workloads — input is usually cached.
// Returns `undefined` for free / unpriced models so callers can fall back.
export function tokensForBudget(
  budgetUSD: number,
  modelID: string | undefined
): number | undefined {
  const price = priceFor(modelID);
  if (!price || price.output <= 0) return undefined;
  return Math.round((budgetUSD / price.output) * 1_000_000);
}

// Populate ModelRef.pricing from the table. Returns the original ref if the
// model isn't in the table (unknown / go-subscription / free tier).
export function withPricing(ref: ModelRef): ModelRef {
  const price = priceFor(ref.id);
  if (!price) return ref;
  return { ...ref, pricing: { input: price.input, output: price.output } };
}
