import { describe, expect, it } from 'vitest';
import { patternMeta, teamSizeWarningMessage } from '../swarm-patterns';
import type { SwarmPattern } from '../swarm-types';

// teamSizeWarningMessage drives both the kickoff WARN (#101) and the
// new-run picker shading (#103). Drift here changes operator-visible
// signal: a too-eager warning trains the user to ignore them; a
// too-quiet one means they ride past empirically-broken sizes.

describe('patternMeta.recommendedMax', () => {
  it('every pattern has a recommendedMax >= 1', () => {
    const patterns: SwarmPattern[] = [
      'none',
      'blackboard',
      'map-reduce',
      'council',
      'orchestrator-worker',
      'role-differentiated',
      'debate-judge',
      'critic-loop',
    ];
    for (const p of patterns) {
      expect(patternMeta[p].recommendedMax).toBeGreaterThanOrEqual(1);
    }
  });

  it('matches MAXTEAM-2026-04-26 stress-test recommendations', () => {
    expect(patternMeta.blackboard.recommendedMax).toBe(6);
    expect(patternMeta.council.recommendedMax).toBe(5);
    expect(patternMeta['map-reduce'].recommendedMax).toBe(5);
    expect(patternMeta['orchestrator-worker'].recommendedMax).toBe(8);
    expect(patternMeta['role-differentiated'].recommendedMax).toBe(6);
    expect(patternMeta['debate-judge'].recommendedMax).toBe(4);
    expect(patternMeta['critic-loop'].recommendedMax).toBe(2);
    expect(patternMeta.none.recommendedMax).toBe(1);
  });
});

describe('teamSizeWarningMessage', () => {
  it('returns undefined when teamSize is at recommendedMax', () => {
    expect(teamSizeWarningMessage('blackboard', 6)).toBeUndefined();
    expect(teamSizeWarningMessage('council', 5)).toBeUndefined();
    expect(teamSizeWarningMessage('debate-judge', 4)).toBeUndefined();
  });

  it('returns undefined when teamSize is below recommendedMax', () => {
    expect(teamSizeWarningMessage('blackboard', 3)).toBeUndefined();
    expect(teamSizeWarningMessage('map-reduce', 4)).toBeUndefined();
  });

  it('returns a warning string when teamSize exceeds recommendedMax', () => {
    const warn = teamSizeWarningMessage('blackboard', 8);
    expect(warn).toBeDefined();
    expect(warn).toMatch(/teamSize=8/);
    expect(warn).toMatch(/recommendedMax=6/);
    expect(warn).toMatch(/blackboard/);
    // Anchored to the stress-test ledger so a future operator can find
    // the failure modes that motivated the threshold.
    expect(warn).toMatch(/MAXTEAM-2026-04-26/);
    expect(warn).toMatch(/docs\/STRESS_TESTS\/2026-04-26-max-team-size-8\.md/);
  });

  it('orchestrator-worker at teamSize=8 does NOT warn (cleanest scaler)', () => {
    expect(teamSizeWarningMessage('orchestrator-worker', 8)).toBeUndefined();
  });

  it('debate-judge at 5 warns (recommendedMax=4)', () => {
    const warn = teamSizeWarningMessage('debate-judge', 5);
    expect(warn).toBeDefined();
    expect(warn).toMatch(/recommendedMax=4/);
  });

  it('critic-loop is hard-capped at 2 by route validator, but helper still works', () => {
    expect(teamSizeWarningMessage('critic-loop', 2)).toBeUndefined();
    // Defensive — even if validator changes, helper shape stays correct.
    expect(teamSizeWarningMessage('critic-loop', 3)).toMatch(/recommendedMax=2/);
  });
});
