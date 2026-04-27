// Historically "families" = model vendors (anthropic, openai, …). Post-
// 2026-04-24 three-tier reversal we overload this with `ollama` as a
// tier marker for the ollama-max subscription models, rather than
// adding an orthogonal `tier` field. This keeps the modal's picker
// rendering unchanged and groups the ollama-tier models visibly under
// one header. The filename `zen-catalog` is now a misnomer — the list
// carries all three tiers' selectable models; rename deferred to avoid
// cross-repo churn.
export type ZenFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'alibaba'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'nvidia'
  | 'stealth'
  | 'ollama';

export interface ZenModel {
  id: string;
  label: string;
  family: ZenFamily;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

// Pricing pulled from https://opencode.ai/docs/zen/ - per 1M tokens.
// cacheWrite is anthropic-only; left at 0 (renders as em-dash) for the rest.
// No tier field: opencode's catalog does not rank models by tier; any such
// label would be editorial, so we omit it on purpose.
export const zenModels: ZenModel[] = [
  { id: 'claude-opus-4.7',   label: 'claude opus 4.7',   family: 'anthropic', in: 5.0,  out: 25.0,  cacheRead: 0.5,   cacheWrite: 6.25 },
  { id: 'claude-opus-4.6',   label: 'claude opus 4.6',   family: 'anthropic', in: 5.0,  out: 25.0,  cacheRead: 0.5,   cacheWrite: 6.25 },
  { id: 'claude-opus-4.5',   label: 'claude opus 4.5',   family: 'anthropic', in: 5.0,  out: 25.0,  cacheRead: 0.5,   cacheWrite: 6.25 },
  { id: 'claude-sonnet-4.6', label: 'claude sonnet 4.6', family: 'anthropic', in: 3.0,  out: 15.0,  cacheRead: 0.3,   cacheWrite: 3.75 },
  { id: 'claude-haiku-4.5',  label: 'claude haiku 4.5',  family: 'anthropic', in: 1.0,  out: 5.0,   cacheRead: 0.1,   cacheWrite: 1.25 },
  { id: 'gpt-5.4-pro',       label: 'gpt 5.4 pro',       family: 'openai',    in: 30.0, out: 180.0, cacheRead: 30.0,  cacheWrite: 0    },
  { id: 'gpt-5.4',           label: 'gpt 5.4',           family: 'openai',    in: 2.5,  out: 15.0,  cacheRead: 0.25,  cacheWrite: 0    },
  { id: 'gpt-5.4-mini',      label: 'gpt 5.4 mini',      family: 'openai',    in: 0.75, out: 4.5,   cacheRead: 0.075, cacheWrite: 0    },
  { id: 'gpt-5.4-nano',      label: 'gpt 5.4 nano',      family: 'openai',    in: 0.2,  out: 1.25,  cacheRead: 0.02,  cacheWrite: 0    },
  { id: 'gpt-5.3-codex',     label: 'gpt 5.3 codex',     family: 'openai',    in: 1.75, out: 14.0,  cacheRead: 0.175, cacheWrite: 0    },
  { id: 'gpt-5.2-codex',     label: 'gpt 5.2 codex',     family: 'openai',    in: 1.75, out: 14.0,  cacheRead: 0.175, cacheWrite: 0    },
  { id: 'gpt-5-codex',       label: 'gpt 5 codex',       family: 'openai',    in: 1.07, out: 8.5,   cacheRead: 0.107, cacheWrite: 0    },
  { id: 'gpt-5-nano-free',   label: 'gpt 5 nano',        family: 'openai',    in: 0,    out: 0,     cacheRead: 0,     cacheWrite: 0    },
  { id: 'gemini-3.1-pro',    label: 'gemini 3.1 pro',    family: 'google',    in: 4.0,  out: 18.0,  cacheRead: 0.4,   cacheWrite: 0    },
  { id: 'gemini-3-flash',    label: 'gemini 3 flash',    family: 'google',    in: 0.5,  out: 3.0,   cacheRead: 0.05,  cacheWrite: 0    },
  { id: 'qwen-3.6-plus',     label: 'qwen 3.6 plus',     family: 'alibaba',   in: 0.5,  out: 3.0,   cacheRead: 0.05,  cacheWrite: 0    },
  { id: 'qwen-3.5-plus',     label: 'qwen 3.5 plus',     family: 'alibaba',   in: 0.2,  out: 1.2,   cacheRead: 0.02,  cacheWrite: 0    },
  { id: 'kimi-k2.5',         label: 'kimi k2.5',         family: 'moonshot',  in: 0.6,  out: 3.0,   cacheRead: 0.1,   cacheWrite: 0    },
  { id: 'glm-5.1',           label: 'glm 5.1',           family: 'zhipu',     in: 1.4,  out: 4.4,   cacheRead: 0.26,  cacheWrite: 0    },
  { id: 'glm-5',             label: 'glm 5',             family: 'zhipu',     in: 1.0,  out: 3.2,   cacheRead: 0.2,   cacheWrite: 0    },
  { id: 'minimax-m2.5',      label: 'minimax m2.5',      family: 'minimax',   in: 0.3,  out: 1.2,   cacheRead: 0.06,  cacheWrite: 0    },
  // Ollama-max tier (ollama.com subscription). IDs include the
  // `ollama/` prefix so `providerOf` in transform.ts routes them to
  // the `ollama` Provider, and `priceFor` in pricing.ts returns 0
  // (subscription). User must configure opencode.json with an
  // `ollama` provider block before these route cleanly. See
  // docs/DESIGN.md §ollama tier.
  { id: 'ollama/nemotron-3-super:cloud',      label: 'nemotron 3 super (ollama)',    family: 'ollama', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  { id: 'ollama/gemma4:31b-cloud',            label: 'gemma4 31b (ollama)',          family: 'ollama', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  { id: 'ollama/kimi-k2.6:cloud',             label: 'kimi k2.6 (ollama)',           family: 'ollama', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  { id: 'ollama/glm-5.1:cloud',               label: 'glm 5.1 (ollama)',             family: 'ollama', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  { id: 'ollama/deepseek-v4-pro:cloud',       label: 'deepseek v4 pro (ollama)',     family: 'ollama', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  { id: 'ollama/mistral-large-3:675b-cloud',  label: 'mistral large 3 675b (ollama)', family: 'ollama', in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
];

export const familyMeta: Record<ZenFamily, { label: string; color: string }> = {
  anthropic: { label: 'anthropic', color: 'text-amber' },
  openai:    { label: 'openai',    color: 'text-mint' },
  google:    { label: 'google',    color: 'text-iris' },
  alibaba:   { label: 'alibaba',   color: 'text-fog-300' },
  moonshot:  { label: 'moonshot',  color: 'text-fog-400' },
  zhipu:     { label: 'zhipu',     color: 'text-fog-300' },
  minimax:   { label: 'minimax',   color: 'text-fog-400' },
  nvidia:    { label: 'nvidia',    color: 'text-fog-300' },
  stealth:   { label: 'stealth',   color: 'text-fog-500' },
  ollama:    { label: 'ollama max', color: 'text-iris' },
};

export const fmtZenPrice = (n: number, isCacheWrite = false): string => {
  if (n === 0) return isCacheWrite ? '\u2014' : '0';
  if (n < 0.1) return n.toFixed(3);
  return n.toFixed(2);
};
