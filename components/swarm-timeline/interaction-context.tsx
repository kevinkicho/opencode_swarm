'use client';

//
// Pre-fix: `onFocus`, `onSelectAgent`, `roleNames` drilled 5 levels
// deep through SwarmTimeline → TimelineFlow → EventCard / ChipCard →
// TimelineNodeCard → ... Every level passed the prop through doing
// nothing with it (no derived behavior, just forwarding). Adding a
// new interaction handler meant touching every level.
//
// Post-fix: a Context provider hangs the three handlers + roleNames
// off the timeline subtree. Rendering components consume via
// useTimelineInteraction(); the prop-drill chain disappears.
//
// `focusedId` and `selectedAgentId` stay as props on the consumers
// that visually depend on them (lane highlight, focus chip outline) —
// pushing those through Context would force every focus change to
// re-render every consumer. The handlers are the right granularity
// for Context because they're stable function references the parent
// owns.

import { createContext, useContext, type ReactNode } from 'react';

export interface TimelineInteractionValue {
  onFocus: (id: string) => void;
  onSelectAgent: (id: string) => void;
  // Per-pattern role labels keyed by `ownerIdForSession`. When set,
  // each lane / chip header shows the role chip instead of the
  // provider name. Empty map → fallback to provider chip.
  roleNames: ReadonlyMap<string, string>;
}

const noopRoleNames: ReadonlyMap<string, string> = new Map();

const TimelineInteractionContext =
  createContext<TimelineInteractionValue | null>(null);

export function TimelineInteractionProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TimelineInteractionValue;
}) {
  return (
    <TimelineInteractionContext.Provider value={value}>
      {children}
    </TimelineInteractionContext.Provider>
  );
}

// Hook for any descendant of TimelineInteractionProvider. Throws when
// used outside — that's a programmer error worth surfacing rather
// than the previous "prop is undefined and click does nothing"
// failure mode.
export function useTimelineInteraction(): TimelineInteractionValue {
  const v = useContext(TimelineInteractionContext);
  if (!v) {
    throw new Error(
      'useTimelineInteraction must be used inside TimelineInteractionProvider',
    );
  }
  return v;
}

// Convenience accessor for read-only consumers (chip badges, role
// labels) that only need roleNames. Falls back to the empty map
// outside a provider so non-timeline call sites can adopt the same
// component without crashing.
export function useTimelineRoleNames(): ReadonlyMap<string, string> {
  const v = useContext(TimelineInteractionContext);
  return v ? v.roleNames : noopRoleNames;
}
