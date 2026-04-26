'use client';

// Selection-tuple state hub for the main page (#7.Q26 decomposition wave 2).
//
// The page tracks 4 mutually-exclusive "what's the inspector showing"
// signals plus a drawerOpen boolean that gates whether the right-side
// panel is visible at all:
//
//   focusedMsgId      — a specific message in the timeline / cards view
//   selectedAgentId   — a roster row
//   selectedFileHeat  — a row on the heat rail
//   drawerOpen        — convenience boolean; closing the drawer also
//                       clears the three selection fields
//
// Originally each had its own useState + a hand-written cluster of
// useCallback handlers (focusMessage, selectAgent, selectFileHeat,
// rosterSelect, clearFocus, closeDrawer, selectSession). Each handler
// repeated the same "set this one, clear the others, open the drawer"
// dance, which made adding a new selection kind error-prone.
//
// This hook owns the tuple and the handlers. Each handler enforces the
// invariant: setting one selection clears the other two and opens the
// drawer. Closing the drawer clears all three. The selectSession handler
// bridges the pattern-rail sessionID → agentID gap by walking the agents
// array (passed in because it's derived in the parent and we don't want
// to re-fetch).

import { useCallback, useState } from 'react';
import type { Agent } from '@/lib/swarm-types';
import type { FileHeat } from '@/lib/opencode/transform';

export interface SelectionState {
  focusedMsgId: string | null;
  selectedAgentId: string | null;
  selectedFileHeat: FileHeat | null;
  drawerOpen: boolean;
  // Toggles: re-clicking the same selection closes the drawer instead
  // of re-selecting, matching the pre-extraction inline behavior.
  focusMessage: (id: string) => void;
  selectFileHeat: (heat: FileHeat) => void;
  // Pure setters (no toggle) — used by surfaces where re-click should
  // never close (e.g. the roster row, where the drawer staying open
  // for the same agent is the intended behavior).
  selectAgent: (id: string) => void;
  // Pattern-rail bridge: maps a raw opencode `sessionID` to the synthesised
  // agent ID by walking the current `agents` array. No-op when no agent
  // has been synthesised yet for that session (rare — between session
  // spawn and first intro post).
  selectSession: (sessionID: string) => void;
  // Like selectAgent but doesn't open the drawer — used by the embedded
  // roster panel in LeftTabs where the user expects "highlight the row,
  // don't pop a drawer over the panel I'm already in."
  rosterSelect: (id: string) => void;
  clearFocus: () => void;
  closeDrawer: () => void;
}

export function useSelectionState(agents: readonly Agent[]): SelectionState {
  const [focusedMsgId, setFocusedMsgId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedFileHeat, setSelectedFileHeat] = useState<FileHeat | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  const focusMessage = useCallback((id: string) => {
    setFocusedMsgId((prev) => {
      if (prev === id) {
        setDrawerOpen(false);
        return null;
      }
      setSelectedAgentId(null);
      setSelectedFileHeat(null);
      setDrawerOpen(true);
      return id;
    });
  }, []);

  const selectAgent = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
    setSelectedFileHeat(null);
    setDrawerOpen(true);
  }, []);

  const selectSession = useCallback(
    (sessionID: string) => {
      if (!sessionID) return;
      const agent = agents.find((a) => a.sessionID === sessionID);
      if (!agent) return;
      setSelectedAgentId(agent.id);
      setFocusedMsgId(null);
      setSelectedFileHeat(null);
      setDrawerOpen(true);
    },
    [agents],
  );

  const rosterSelect = useCallback((id: string) => {
    setSelectedAgentId(id);
    setFocusedMsgId(null);
    setSelectedFileHeat(null);
  }, []);

  const selectFileHeat = useCallback((heat: FileHeat) => {
    setSelectedFileHeat((prev) => {
      if (prev?.path === heat.path) {
        setDrawerOpen(false);
        return null;
      }
      setFocusedMsgId(null);
      setSelectedAgentId(null);
      setDrawerOpen(true);
      return heat;
    });
  }, []);

  const clearFocus = useCallback(() => {
    setFocusedMsgId(null);
    setSelectedAgentId(null);
    setSelectedFileHeat(null);
    setDrawerOpen(false);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setFocusedMsgId(null);
    setSelectedAgentId(null);
    setSelectedFileHeat(null);
  }, []);

  return {
    focusedMsgId,
    selectedAgentId,
    selectedFileHeat,
    drawerOpen,
    focusMessage,
    selectAgent,
    selectSession,
    rosterSelect,
    selectFileHeat,
    clearFocus,
    closeDrawer,
  };
}
