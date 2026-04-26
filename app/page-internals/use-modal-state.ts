'use client';

// Modal-flag state hub for the main page (#7.Q26 decomposition wave 2).
//
// The page hosts 8 mutually-exclusive overlays: command palette, routing
// editor, live commit history, spawn-agent, glossary, new run, run
// provenance, cost dashboard. Originally each had its own `useState`
// declaration inline in PageBody — that's 8 paired flag/setter lines
// taking the top of the function body, plus 8 `() => setXxx(false)`
// inline lambdas at every modal's onClose, plus duplicated open-handler
// closures sprinkled across the page wiring.
//
// This hook collapses all of that into one bag with stable closers.
// Returned object is referentially stable across renders so consumer
// memos that depend on `closers.palette` etc. don't re-fire.

import { useCallback, useMemo, useState } from 'react';

export interface PageModalState {
  // Open flags (read-only via this hook; writers are in `openers`).
  flags: {
    palette: boolean;
    routing: boolean;
    history: boolean;
    spawn: boolean;
    glossary: boolean;
    newRun: boolean;
    provenance: boolean;
    cost: boolean;
  };
  // Imperative openers — call to mount the corresponding modal. Stable
  // identity (useCallback with no deps) so passing them down won't
  // invalidate downstream memos.
  openers: {
    palette: () => void;
    togglePalette: () => void;
    routing: () => void;
    history: () => void;
    spawn: () => void;
    glossary: () => void;
    newRun: () => void;
    provenance: () => void;
    cost: () => void;
  };
  // Imperative closers — call to dismiss. Stable identity.
  closers: {
    palette: () => void;
    routing: () => void;
    history: () => void;
    spawn: () => void;
    glossary: () => void;
    newRun: () => void;
    provenance: () => void;
    cost: () => void;
  };
}

export function useModalState(): PageModalState {
  const [palette, setPalette] = useState(false);
  const [routing, setRouting] = useState(false);
  const [history, setHistory] = useState(false);
  const [spawn, setSpawn] = useState(false);
  const [glossary, setGlossary] = useState(false);
  const [newRun, setNewRun] = useState(false);
  const [provenance, setProvenance] = useState(false);
  const [cost, setCost] = useState(false);

  const flags = useMemo(
    () => ({ palette, routing, history, spawn, glossary, newRun, provenance, cost }),
    [palette, routing, history, spawn, glossary, newRun, provenance, cost],
  );

  // Openers / closers split rather than a single setter map so JSX call
  // sites read as `openers.palette()` not `setters.palette(true)` — the
  // intent (open vs close) is in the verb, not buried in a boolean.
  const openers = useMemo(
    () => ({
      palette: () => setPalette(true),
      togglePalette: () => setPalette((p) => !p),
      routing: () => setRouting(true),
      history: () => setHistory(true),
      spawn: () => setSpawn(true),
      glossary: () => setGlossary(true),
      newRun: () => setNewRun(true),
      provenance: () => setProvenance(true),
      cost: () => setCost(true),
    }),
    [],
  );

  const closers = useMemo(
    () => ({
      palette: () => setPalette(false),
      routing: () => setRouting(false),
      history: () => setHistory(false),
      spawn: () => setSpawn(false),
      glossary: () => setGlossary(false),
      newRun: () => setNewRun(false),
      provenance: () => setProvenance(false),
      cost: () => setCost(false),
    }),
    [],
  );

  return useMemo(() => ({ flags, openers, closers }), [flags, openers, closers]);
}
