import type { ModelRef } from './swarm-types';

export const modelCatalog: ModelRef[] = [
  {
    id: 'opencode/claude-opus-4-7',
    label: 'claude-opus-4-7',
    provider: 'zen',
    family: 'claude',
    pricing: { input: 5, output: 25 },
  },
  {
    id: 'opencode/claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
    provider: 'zen',
    family: 'claude',
    pricing: { input: 3, output: 15 },
  },
  {
    id: 'opencode/claude-haiku-4-5',
    label: 'claude-haiku-4-5',
    provider: 'zen',
    family: 'claude',
    pricing: { input: 1, output: 5 },
  },
  {
    id: 'opencode/gpt-5.2',
    label: 'gpt-5.2',
    provider: 'zen',
    family: 'gpt',
    pricing: { input: 4, output: 20 },
  },
  {
    id: 'opencode/gemini-2.5-pro',
    label: 'gemini-2.5-pro',
    provider: 'zen',
    family: 'gemini',
    pricing: { input: 2.5, output: 12 },
  },
  {
    id: 'opencode/qwen3.6-plus',
    label: 'qwen3.6-plus',
    provider: 'go',
    family: 'qwen',
    pricing: { input: 0.5, output: 3 },
    limitTag: 'go 5h $12',
  },
  {
    id: 'opencode/kimi-k2',
    label: 'kimi-k2',
    provider: 'go',
    family: 'kimi',
    pricing: { input: 0.4, output: 2.5 },
    limitTag: 'go 5h $12',
  },
  {
    id: 'opencode/glm-4.6',
    label: 'glm-4.6',
    provider: 'go',
    family: 'glm',
    pricing: { input: 0.35, output: 2 },
    limitTag: 'go 5h $12',
  },
  {
    id: 'opencode/minimax-m2',
    label: 'minimax-m2',
    provider: 'go',
    family: 'minimax',
    pricing: { input: 0.3, output: 1.8 },
    limitTag: 'go 5h $12',
  },
  {
    id: 'byok/claude-opus-4-7',
    label: 'claude-opus-4-7',
    provider: 'byok',
    family: 'claude',
    pricing: { input: 5, output: 25 },
  },
  // Ollama tier (ollama.com subscription — ollama max plan). All models
  // carry pricing: { 0, 0 } because billing is monthly-flat, not per-
  // token; the cost derivations treat 0 as "bundled" so provider stats
  // show the split by message volume, not dollars. Added 2026-04-24
  // alongside the three-tier stance reversal. User must configure
  // opencode.json to route the `ollama/` model IDs to an ollama provider
  // endpoint — see docs/DESIGN.md.
  {
    id: 'ollama/nemotron-3-super:cloud',
    label: 'nemotron-3-super',
    provider: 'ollama',
    family: 'nemotron',
    pricing: { input: 0, output: 0 },
    limitTag: 'ollama max',
  },
  {
    id: 'ollama/gemma4:31b-cloud',
    label: 'gemma4:31b',
    provider: 'ollama',
    family: 'gemma',
    pricing: { input: 0, output: 0 },
    limitTag: 'ollama max',
  },
  {
    id: 'ollama/kimi-k2.6:cloud',
    label: 'kimi-k2.6',
    provider: 'ollama',
    family: 'kimi',
    pricing: { input: 0, output: 0 },
    limitTag: 'ollama max',
  },
  {
    id: 'ollama/glm-5.1:cloud',
    label: 'glm-5.1',
    provider: 'ollama',
    family: 'glm',
    pricing: { input: 0, output: 0 },
    limitTag: 'ollama max',
  },
  {
    // Default planner/orchestrator-seat model as of 2026-04-27
    // (replaces ollama/glm-5.1:cloud per user). glm-5.1 stays in
    // the catalog above and is still selectable manually; new runs
    // that don't override teamModels[0] now get deepseek instead.
    id: 'ollama/deepseek-v4-pro:cloud',
    label: 'deepseek-v4-pro',
    provider: 'ollama',
    family: 'deepseek',
    pricing: { input: 0, output: 0 },
    limitTag: 'ollama max',
  },
  {
    id: 'ollama/mistral-large-3:675b-cloud',
    label: 'mistral-large-3:675b',
    provider: 'ollama',
    family: 'mistral',
    pricing: { input: 0, output: 0 },
    limitTag: 'ollama max',
  },
];
