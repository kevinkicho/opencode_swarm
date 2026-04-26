'use client';

// Page-level view-state hub (#7.Q26 decomposition wave 2 pass 5).
//
// Owns three pieces of UI state that share concerns:
//   - leftTab        the cross-pattern left-rail tab (plan / roster / board / heat)
//   - runView        the main-viewport view (timeline / cards / pattern-specific rails)
//   - focusTodoId    a transient "scroll + flash this todo" pointer
//
// They cluster because:
// 1. `jumpToTodo` is a cross-cutting handler that flips leftTab → 'plan'
//    AND sets focusTodoId AND clears focusTodoId after the flash —
//    spans all three pieces.
// 2. The runView auto-reset effect needs to fire whenever the active
//    view's gate stops applying (e.g., user navigates from a critic-loop
//    run with `iterations` selected to a council run where `iterations`
//    is no longer enabled). Tied to the same render cycle as the tab
//    state.
//
// Without this hook PageBody hand-wires three useState/useEffect/
// useCallback blocks and the cross-cutting jumpToTodo handler ends up
// looking deeper into hook details than necessary.

import { useCallback, useEffect, useState } from 'react';

export type LeftTab = 'plan' | 'roster' | 'board' | 'heat';

export interface ViewState<RunView extends string> {
  leftTab: LeftTab;
  setLeftTab: (tab: LeftTab) => void;
  runView: RunView;
  setRunView: (view: RunView) => void;
  focusTodoId: string | null;
  // Imperative: flip left to 'plan', flash the todo with the given id.
  // Cleared automatically after FOCUS_FLASH_MS so re-clicking the same
  // todo re-triggers the visual.
  jumpToTodo: (todoId: string) => void;
}

// Visual-flash window for the focusTodoId pointer. 1200ms covers
// smooth scroll into view + a beat for the user to register the
// highlight, then we clear so re-clicking the same todo re-triggers.
const FOCUS_FLASH_MS = 1200;

// `isViewEnabled` is called with just the runView; the caller closes
// over their own context (swarmRunMeta.pattern, boardSwarmRunID, etc.)
// when constructing it. The hook stays free of the VIEW_PATTERN_GATES
// table that lives in page.tsx — would otherwise force a circular
// import. `gateDeps` tells the auto-reset effect which inputs to
// observe; pass the same primitive values the gate closure depends on.
export function useViewState<RunView extends string>(
  defaultView: RunView,
  isViewEnabled: (view: RunView) => boolean,
  gateDeps: readonly unknown[],
): ViewState<RunView> {
  const [leftTab, setLeftTab] = useState<LeftTab>('plan');
  const [runView, setRunView] = useState<RunView>(defaultView);
  const [focusTodoId, setFocusTodoId] = useState<string | null>(null);

  // Auto-reset runView when its enabling condition stops applying.
  // Without this the main viewport renders null when the user navigates
  // from a pattern-specific view to a run that doesn't support that view.
  useEffect(() => {
    if (!isViewEnabled(runView)) {
      setRunView(defaultView);
    }
    // Caller-supplied gateDeps: the primitives the gate closure reads.
    // Stable identity for `isViewEnabled` would let us include it, but
    // the typical call site rebuilds the closure each render; including
    // it would re-fire the effect every render. The runView + gateDeps
    // dependency set captures every input the gate actually consults.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runView, ...gateDeps]);

  const jumpToTodo = useCallback((todoId: string) => {
    setLeftTab('plan');
    setFocusTodoId(todoId);
    window.setTimeout(() => setFocusTodoId(null), FOCUS_FLASH_MS);
  }, []);

  return { leftTab, setLeftTab, runView, setRunView, focusTodoId, jumpToTodo };
}
