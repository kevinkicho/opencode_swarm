'use client';

// Provider-tier metadata + filter hook shared across the new-run team
// picker and the spawn-agent modal. Both surfaces present a row-per-
// model list filtered by provider tier (go / zen / ollama / byok); the
// chip strip + filter state + per-tier counts are identical.
//
// Pre-2026-04-28 these lived inline in components/new-run/team-section.
// The spawn modal grew its own provider-tier filter, so the data + hook
// moved here. Chip rendering stays per-modal because the column widths
// and surrounding context differ; only the data and state are shared.

import { useMemo, useState } from 'react';
import type { Provider } from './swarm-types';
import type { ProviderModel } from '@/app/api/swarm/providers/route';

export interface ProviderTierMeta {
  label: string;
  // Tailwind color class for the active chip's text.
  accent: string;
  // Tooltip text explaining the routing semantics.
  hint: string;
}

export const PROVIDER_META: Record<Provider, ProviderTierMeta> = {
  go: {
    label: 'go',
    accent: 'text-mint',
    hint: 'opencode-go — free daily quota first; if "extra usage" is enabled in opencode.ai dashboard, falls through to zen billing on quota hit. preferred default.',
  },
  zen: {
    label: 'zen',
    accent: 'text-molten',
    hint: 'opencode-zen — direct metered billing. picking these over go skips the free quota and bills per-token immediately.',
  },
  ollama: {
    label: 'ollama',
    accent: 'text-iris',
    hint: 'ollama-max subscription bundle ($100/mo). per-token cost is imputed from quota; bundle covers all usage up to the weekly token cap.',
  },
  byok: {
    label: 'byok',
    accent: 'text-fog-400',
    hint: 'bring-your-own-key — direct provider keys configured in opencode.json. only shows up when you have BYOK provider blocks.',
  },
};

// Order matches the recommended preference: go (free quota first) →
// zen (metered) → ollama (subscription) → byok.
export const PROVIDER_ORDER: readonly Provider[] = ['go', 'zen', 'ollama', 'byok'];

export interface UseProviderFilterResult {
  providerFilter: Set<Provider>;
  // Counts across the full unfiltered catalog, so the chip badges
  // show "go 4 · zen 12 · ollama 6" regardless of what's currently
  // toggled.
  providerCounts: Record<Provider, number>;
  filteredModels: ProviderModel[];
  toggleProvider: (p: Provider) => void;
  // Tier ids that have ≥1 model in the catalog. Useful for filtering
  // chip rendering — no point showing "byok 0".
  availableProviders: readonly Provider[];
}

// Local UI state — doesn't bleed into form submission. The model IDs
// already encode the tier via prefix (e.g. opencode-go/glm-5.1:cloud
// means "go" tier), so the filter is purely a presentation layer.
//
// Defaults: every tier with ≥1 model is selected, so the user sees
// the same flat list as before until they actively narrow.
//
// Implementation note — we DON'T seed `providerFilter` via useState
// initializer because the catalog is async: on first render
// `availableProviders` is empty (TanStack still resolving), so the
// initializer would lock the filter to ∅ permanently. Instead we
// store the user's explicit override (or null = "no override yet")
// and derive the effective filter from {override ?? all-available}
// on every render. The render is cheap (3-4 items); the alternative
// (useEffect to seed once catalog hydrates) flashes an empty list
// for one frame.
export function useProviderFilter(orderedModels: ProviderModel[]): UseProviderFilterResult {
  const availableProviders = useMemo(() => {
    const set = new Set<Provider>();
    orderedModels.forEach((m) => set.add(m.provider));
    return PROVIDER_ORDER.filter((p) => set.has(p));
  }, [orderedModels]);

  const [userOverride, setUserOverride] = useState<Set<Provider> | null>(null);
  const providerFilter = useMemo(
    () => userOverride ?? new Set(availableProviders),
    [userOverride, availableProviders],
  );

  const filteredModels = useMemo(
    () => orderedModels.filter((m) => providerFilter.has(m.provider)),
    [orderedModels, providerFilter],
  );

  const providerCounts = useMemo(() => {
    const counts: Record<Provider, number> = { go: 0, zen: 0, ollama: 0, byok: 0 };
    orderedModels.forEach((m) => {
      counts[m.provider] += 1;
    });
    return counts;
  }, [orderedModels]);

  const toggleProvider = (p: Provider) => {
    setUserOverride((prev) => {
      const base = prev ?? new Set(availableProviders);
      const next = new Set(base);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return {
    providerFilter,
    providerCounts,
    filteredModels,
    toggleProvider,
    availableProviders,
  };
}
