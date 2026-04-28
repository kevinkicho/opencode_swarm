// Live provider/model catalog — the single source of truth for what the UI
// can dispatch to. Talks to opencode's /config/providers endpoint and folds
// per-model metadata (display label, family color, limit tag) from our
// static catalogs (lib/zen-catalog.ts, lib/model-catalog.ts) on top.
//
// Why this exists: prior to 2026-04-27 the new-run modal and inspector
// model picker read directly from the static `zenModels` / `modelCatalog`
// arrays. Adding a model to opencode.json required a matching code edit
// here, and mismatches were silent (model dispatched 204 / sat forever).
// The deepseek-v4-pro saga (2026-04-27) traced two distinct routing bugs
// to that two-source-of-truth split. Going live-first eliminates the gap.
//
// Behavior on opencode-unreachable: returns 200 with `source: 'fallback'`
// and the static catalog converted to the same shape. The UI degrades to
// "what we shipped with" rather than empty pickers — better than a hard
// failure during dev when opencode is being restarted.
//
// Caching: module-scoped 30s TTL. The provider list only changes on
// opencode restart (provider blocks live in opencode.json), so even 30s
// is conservative — but it keeps the proxy hop off the hot path for the
// modal which mounts on every "new run" click.

import { opencodeFetch } from '@/lib/opencode/client';
import { providerOf } from '@/lib/opencode/transform/_shared';
import { zenModels, type ZenFamily, type ZenModel } from '@/lib/zen-catalog';
import { modelCatalog } from '@/lib/model-catalog';
import type { ModelRef, Provider } from '@/lib/swarm-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface OpencodeProviderModelRaw {
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface OpencodeProviderRaw {
  id?: string;
  name?: string;
  models?: Record<string, OpencodeProviderModelRaw> | OpencodeProviderModelRaw[];
}

interface OpencodeProvidersRaw {
  providers?: OpencodeProviderRaw[];
  default?: Record<string, string>;
}

export interface ProviderModel extends ModelRef {
  // canonical "<providerID>/<modelID>" id is on ModelRef.id
  modelID: string;
  providerID: string;
  // Vendor-of-origin for the FamilyCell in the run picker (anthropic/
  // openai/google/...). Distinct from `family` (model-line: claude/gpt/
  // gemini/...). One model has both — `family: 'gpt'` + `vendor: 'openai'`.
  vendor: ZenFamily;
  // Cache pricing (per-1M tokens) for the spawn modal's wider price grid.
  // Only populated when the static override carries them — opencode's
  // /config/providers cost block doesn't surface cache rates today.
  cacheRead?: number;
  cacheWrite?: number;
  contextLimit?: number;
  outputLimit?: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ProviderModel[];
}

export interface ProviderSnapshot {
  source: 'live' | 'fallback';
  fetchedAt: number;
  providers: ProviderInfo[];
  defaults?: Record<string, string>;
  // Surface the upstream error so the UI can show a quiet "live catalog
  // unavailable" hint when source==='fallback'.
  error?: string;
}

const CACHE_KEY = Symbol.for('opencode_swarm.providersCache.v1');
const CACHE_TTL_MS = 30_000;
interface CacheSlot {
  snapshot: ProviderSnapshot;
  fetchedAt: number;
}
function getCache(): { slot: CacheSlot | undefined; set: (s: CacheSlot) => void } {
  const g = globalThis as { [CACHE_KEY]?: CacheSlot };
  return {
    slot: g[CACHE_KEY],
    set: (s) => {
      g[CACHE_KEY] = s;
    },
  };
}

// Build a quick lookup over our static catalog so a live model can adopt
// nicer labels / family colors / limit tags when we have an override.
// Keys are canonical `<providerID>/<modelID>`. Two entries can supply
// metadata: zenModels (preferred, since it's the more curated catalog)
// and modelCatalog (fallback for older entries).
interface StaticOverride {
  label?: string;
  family?: ModelRef['family'];
  vendor?: ZenFamily;
  limitTag?: string;
  pricing?: ModelRef['pricing'];
  cacheRead?: number;
  cacheWrite?: number;
}

const STATIC_OVERRIDES = (() => {
  const m = new Map<string, StaticOverride>();
  for (const z of zenModels as ZenModel[]) {
    m.set(z.id, {
      label: z.label,
      family: familyFromZen(z),
      vendor: z.family,
      pricing: { input: z.in, output: z.out },
      cacheRead: z.cacheRead,
      cacheWrite: z.cacheWrite,
    });
  }
  for (const c of modelCatalog) {
    const existing = m.get(c.id) ?? {};
    m.set(c.id, {
      label: existing.label ?? c.label,
      family: existing.family ?? c.family,
      vendor: existing.vendor,
      limitTag: existing.limitTag ?? c.limitTag,
      pricing: existing.pricing ?? c.pricing,
      cacheRead: existing.cacheRead,
      cacheWrite: existing.cacheWrite,
    });
  }
  return m;
})();

function familyFromZen(z: ZenModel): ModelRef['family'] {
  const id = z.id.toLowerCase();
  if (id.includes('claude')) return 'claude';
  if (id.includes('gpt')) return 'gpt';
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('qwen')) return 'qwen';
  if (id.includes('kimi')) return 'kimi';
  if (id.includes('glm')) return 'glm';
  if (id.includes('nemotron')) return 'nemotron';
  if (id.includes('gemma')) return 'gemma';
  if (id.includes('mistral')) return 'mistral';
  if (id.includes('minimax')) return 'minimax';
  if (id.includes('mimo')) return 'mimo';
  if (id.includes('deepseek')) return 'deepseek';
  return 'claude';
}

function inferFamily(modelID: string): ModelRef['family'] {
  // Same logic as familyOf in lib/opencode/transform/_shared.ts; duplicated
  // here so this route doesn't pull in the transform package's full graph.
  const m = modelID.toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt')) return 'gpt';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('glm')) return 'glm';
  if (m.includes('nemotron')) return 'nemotron';
  if (m.includes('gemma')) return 'gemma';
  if (m.includes('mistral')) return 'mistral';
  if (m.includes('minimax')) return 'minimax';
  if (m.includes('mimo')) return 'mimo';
  if (m.includes('deepseek')) return 'deepseek';
  return 'claude';
}

// Vendor inference for the FamilyCell display. Maps model-line family
// (claude/gpt/...) to its vendor of origin (anthropic/openai/...). For
// the ollama tier we honor the providerID — every ollama-cloud model
// renders as 'ollama' regardless of the model's actual vendor, since the
// routing tier is what matters to the user picking from the modal.
function inferVendor(family: ModelRef['family'], providerID: string): ZenFamily {
  if (providerID.toLowerCase().includes('ollama')) return 'ollama';
  switch (family) {
    case 'claude': return 'anthropic';
    case 'gpt': return 'openai';
    case 'gemini':
    case 'gemma': return 'google';
    case 'qwen': return 'alibaba';
    case 'kimi': return 'moonshot';
    case 'glm': return 'zhipu';
    case 'minimax': return 'minimax';
    case 'nemotron': return 'nvidia';
    case 'mistral':
    case 'mimo':
    case 'deepseek':
    default: return 'stealth';
  }
}

function normalizeModelsField(
  models: OpencodeProviderRaw['models'],
): OpencodeProviderModelRaw[] {
  if (!models) return [];
  if (Array.isArray(models)) return models;
  return Object.entries(models).map(([id, m]) => ({ ...m, id: m.id ?? id }));
}

function toProviderModel(
  providerID: string,
  raw: OpencodeProviderModelRaw,
): ProviderModel | null {
  const modelID = raw.id;
  if (!modelID) return null;
  const canonical = `${providerID}/${modelID}`;
  const override = STATIC_OVERRIDES.get(canonical);
  // Live cost (when opencode reports it) is per-token; our pricing is per-1M.
  // Multiply by 1e6 to convert. opencode 0-cost rows for ollama-cloud are
  // accurate (subscription) but the catalog override carries the imputed
  // $0.02 per-1M figure so the UI can render a non-empty price column.
  const livePricing: ModelRef['pricing'] | undefined = raw.cost
    ? {
        input: (raw.cost.input ?? 0) * 1e6,
        output: (raw.cost.output ?? 0) * 1e6,
      }
    : undefined;
  // Override > live > undefined. The override is more curated (covers our
  // imputed ollama-max pricing) and we don't want a 0/0 live row to wipe
  // it out.
  const pricing = override?.pricing ?? livePricing;
  const family = override?.family ?? inferFamily(modelID);
  return {
    id: canonical,
    modelID,
    providerID,
    label: override?.label ?? raw.name ?? modelID,
    provider: providerOf(providerID) as Provider,
    family,
    vendor: override?.vendor ?? inferVendor(family, providerID),
    pricing,
    limitTag: override?.limitTag,
    cacheRead: override?.cacheRead ?? (raw.cost?.cache_read != null ? raw.cost.cache_read * 1e6 : undefined),
    cacheWrite: override?.cacheWrite ?? (raw.cost?.cache_write != null ? raw.cost.cache_write * 1e6 : undefined),
    contextLimit: raw.limit?.context,
    outputLimit: raw.limit?.output,
  };
}

function toProviderInfo(raw: OpencodeProviderRaw): ProviderInfo | null {
  const id = raw.id;
  if (!id) return null;
  const models = normalizeModelsField(raw.models)
    .map((m) => toProviderModel(id, m))
    .filter((m): m is ProviderModel => m !== null);
  return {
    id,
    name: raw.name ?? id,
    models,
  };
}

// Convert our static catalogs into the same snapshot shape so the UI
// has a non-empty fallback when opencode is unreachable. We group by
// the providerID portion of the model id (the part before the slash);
// model ids without a slash bucket under 'opencode' (zen routing).
function buildFallbackSnapshot(error: string): ProviderSnapshot {
  const grouped = new Map<string, ProviderModel[]>();
  for (const m of modelCatalog) {
    const slash = m.id.indexOf('/');
    const providerID = slash >= 0 ? m.id.slice(0, slash) : 'opencode';
    const modelID = slash >= 0 ? m.id.slice(slash + 1) : m.id;
    const arr = grouped.get(providerID) ?? [];
    arr.push({
      id: m.id,
      modelID,
      providerID,
      label: m.label,
      provider: m.provider,
      family: m.family,
      vendor: inferVendor(m.family, providerID),
      pricing: m.pricing,
      limitTag: m.limitTag,
    });
    grouped.set(providerID, arr);
  }
  // Layer in zen catalog rows that aren't already covered by modelCatalog —
  // zenModels has a wider set, so this fills out the picker.
  for (const z of zenModels as ZenModel[]) {
    const slash = z.id.indexOf('/');
    const providerID = slash >= 0 ? z.id.slice(0, slash) : 'opencode';
    const modelID = slash >= 0 ? z.id.slice(slash + 1) : z.id;
    const arr = grouped.get(providerID) ?? [];
    if (arr.some((existing) => existing.id === z.id)) continue;
    const family = familyFromZen(z);
    arr.push({
      id: z.id,
      modelID,
      providerID,
      label: z.label,
      provider: providerOf(providerID) as Provider,
      family,
      vendor: z.family,
      pricing: { input: z.in, output: z.out },
      cacheRead: z.cacheRead,
      cacheWrite: z.cacheWrite,
    });
    grouped.set(providerID, arr);
  }
  const providers: ProviderInfo[] = Array.from(grouped.entries()).map(([id, models]) => ({
    id,
    name: id,
    models,
  }));
  return {
    source: 'fallback',
    fetchedAt: Date.now(),
    providers,
    error,
  };
}

async function fetchLiveSnapshot(): Promise<ProviderSnapshot> {
  // /config/providers is the modern endpoint; older opencode builds expose
  // the equivalent at /provider. Try the canonical path first.
  let raw: OpencodeProvidersRaw | null = null;
  let lastErr: Error | null = null;
  for (const path of ['/config/providers', '/provider']) {
    try {
      const res = await opencodeFetch(path);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      raw = (await res.json()) as OpencodeProvidersRaw;
      break;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  if (!raw) {
    throw lastErr ?? new Error('opencode unreachable');
  }
  const providers = (raw.providers ?? [])
    .map(toProviderInfo)
    .filter((p): p is ProviderInfo => p !== null && p.models.length > 0);
  return {
    source: 'live',
    fetchedAt: Date.now(),
    providers,
    defaults: raw.default,
  };
}

export async function GET(): Promise<Response> {
  const cache = getCache();
  if (cache.slot && Date.now() - cache.slot.fetchedAt < CACHE_TTL_MS) {
    return Response.json(cache.slot.snapshot);
  }
  let snapshot: ProviderSnapshot;
  try {
    snapshot = await fetchLiveSnapshot();
  } catch (err) {
    snapshot = buildFallbackSnapshot((err as Error).message);
  }
  cache.set({ snapshot, fetchedAt: Date.now() });
  return Response.json(snapshot);
}
