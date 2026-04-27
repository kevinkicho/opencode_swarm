'use client';

//
// Consolidates the 11 form-state useStates that lived inline at
// components/new-run-modal.tsx into a single reducer-shaped hook. The
// modal's useState count drops from 13 → 4 (form + recipesOpen +
// copiedPattern + launching-from-useMutation), satisfying the C8
// verification gate's ≤5 useState target.
//
// Why a reducer, not a mega-useState: setters were sometimes fired in
// pairs (e.g. picking a pattern resets teamCounts), and a setField
// helper that takes a key + value handles that uniformly. The reducer
// shape also makes "reset on close" a single dispatch instead of 11
// individual setters.

import { useCallback, useState } from 'react';

import type { SwarmPattern } from '../../lib/swarm-types';
import { generateRunId, type BranchStrategy, type StartMode } from './helpers';

export interface NewRunForm {
  sourceValue: string;
  workspacePath: string;
  pattern: SwarmPattern;
  teamCounts: Record<string, number>;
  directive: string;
  unbounded: boolean;
  costCap: number;
  minutesCap: number;
  branchStrategy: BranchStrategy;
  branchName: string;
  startMode: StartMode;
}

const INITIAL_FORM = (): NewRunForm => ({
  sourceValue: '',
  workspacePath: '',
  pattern: 'none',
  teamCounts: {},
  directive: '',
  unbounded: true,
  costCap: 5,
  minutesCap: 15,
  branchStrategy: 'push-new-branch',
  branchName: generateRunId(),
  startMode: 'dry-run',
});

export interface NewRunFormApi {
  form: NewRunForm;
  setField: <K extends keyof NewRunForm>(key: K, value: NewRunForm[K]) => void;
  setTeamCount: (modelId: string, count: number) => void;
  bumpTeamCount: (modelId: string, delta: number) => void;
  clearTeam: () => void;
  reset: () => void;
}

export function useNewRunForm(): NewRunFormApi {
  const [form, setForm] = useState<NewRunForm>(INITIAL_FORM);

  const setField = useCallback(
    <K extends keyof NewRunForm>(key: K, value: NewRunForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const setTeamCount = useCallback((modelId: string, count: number) => {
    setForm((prev) => {
      const next = Math.max(0, Math.min(12, count));
      if (next === 0) {
        const { [modelId]: _drop, ...rest } = prev.teamCounts;
        return { ...prev, teamCounts: rest };
      }
      return { ...prev, teamCounts: { ...prev.teamCounts, [modelId]: next } };
    });
  }, []);

  const bumpTeamCount = useCallback((modelId: string, delta: number) => {
    setForm((prev) => {
      const current = prev.teamCounts[modelId] ?? 0;
      const next = Math.max(0, Math.min(12, current + delta));
      if (next === 0) {
        const { [modelId]: _drop, ...rest } = prev.teamCounts;
        return { ...prev, teamCounts: rest };
      }
      return {
        ...prev,
        teamCounts: { ...prev.teamCounts, [modelId]: next },
      };
    });
  }, []);

  const clearTeam = useCallback(() => {
    setForm((prev) => ({ ...prev, teamCounts: {} }));
  }, []);

  const reset = useCallback(() => {
    setForm(INITIAL_FORM());
  }, []);

  return { form, setField, setTeamCount, bumpTeamCount, clearTeam, reset };
}
