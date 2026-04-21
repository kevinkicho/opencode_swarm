'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

// Run-level bounds the routing modal saves. Declarative — these are caps, not
// assignments. Dispatch logic reads them; human edits them via the modal.
export interface RoutingBounds {
  costCap: number;
  tokenCap: number;
  minutesCap: number;
  zenCeiling: number;
  goCeiling: number;
}

export const defaultBounds: RoutingBounds = {
  costCap: 5.0,
  tokenCap: 200_000,
  minutesCap: 15,
  zenCeiling: 60,
  goCeiling: 100,
};

interface Ctx {
  bounds: RoutingBounds;
  save: (next: RoutingBounds) => void;
  reset: () => void;
}

const RoutingBoundsContext = createContext<Ctx | null>(null);

const STORAGE_KEY = 'opencode_enhanced_ui.routing_bounds';

// Shape-check a parsed blob against defaults so an old / partial payload
// doesn't brick the UI — we only trust a blob where every key is a number.
function readStorage(): RoutingBounds | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const k of Object.keys(defaultBounds) as (keyof RoutingBounds)[]) {
      if (typeof parsed[k] !== 'number') return null;
    }
    return parsed as unknown as RoutingBounds;
  } catch {
    return null;
  }
}

export function RoutingBoundsProvider({ children }: { children: ReactNode }) {
  const [bounds, setBounds] = useState<RoutingBounds>(defaultBounds);

  // Hydrate once on mount. Can't be the initial state because localStorage
  // access would break SSR — defaults serve the first render, then we sync.
  useEffect(() => {
    const stored = readStorage();
    if (stored) setBounds(stored);
  }, []);

  const save = useCallback((next: RoutingBounds) => {
    setBounds(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage quota / private-mode failures — bounds still live in memory.
    }
  }, []);

  const reset = useCallback(() => {
    setBounds(defaultBounds);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage failure.
    }
  }, []);

  return (
    <RoutingBoundsContext.Provider value={{ bounds, save, reset }}>
      {children}
    </RoutingBoundsContext.Provider>
  );
}

export function useRoutingBounds(): Ctx {
  const ctx = useContext(RoutingBoundsContext);
  if (!ctx) {
    throw new Error('useRoutingBounds must be used within RoutingBoundsProvider');
  }
  return ctx;
}
