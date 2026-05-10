import { describe, expect, it } from 'vitest';
import { patternMeta, teamSizeWarningMessage } from '../swarm-patterns';
import type { SwarmPattern } from '../swarm-types';

// teamSizeWarningMessage drives both the kickoff WARN (#101) and the
// new-run picker shading (#103). Drift here changes operator-visible
// signal: a too-eager warning trains the user to ignore them; a
// too-quiet one means they ride past empirically-broken sizes.
//
// 2026-05-08 update: recommendedMax lowered to 2 across all patterns
// based on Monte Carlo simulation showing 2 workers = same output as 6.

describe('patternMeta.recommendedMax', () => {
  it('every pattern has a recommendedMax >= 1', () => {
    const patterns: SwarmPattern[] = [
      'none',
      'blackboard',
      'map-reduce',
      'council',
      'orchestrator-worker',
      'debate-judge',
      'critic-loop',
    ];
    for (const p of patterns) {
      expect(patternMeta[p].recommendedMax).toBeGreaterThanOrEqual(1);
    }
  });

  it('all patterns default to recommendedMax=2 per MC simulation', () => {
    expect(patternMeta.blackboard.recommendedMax).toBe(2);
    expect(patternMeta.council.recommendedMax).toBe(2);
    expect(patternMeta['map-reduce'].recommendedMax).toBe(2);
    expect(patternMeta['orchestrator-worker'].recommendedMax).toBe(2);
    expect(patternMeta['debate-judge'].recommendedMax).toBe(2);
    expect(patternMeta['critic-loop'].recommendedMax).toBe(2);
    expect(patternMeta.none.recommendedMax).toBe(1);
  });
});

describe('teamSizeWarningMessage', () => {
  it('returns undefined when teamSize is at recommendedMax', () => {
    expect(teamSizeWarningMessage('blackboard', 2)).toBeUndefined();
    expect(teamSizeWarningMessage('council', 2)).toBeUndefined();
    expect(teamSizeWarningMessage('debate-judge', 2)).toBeUndefined();
  });

  it('returns undefined when teamSize is below recommendedMax', () => {
    expect(teamSizeWarningMessage('blackboard', 1)).toBeUndefined();
  });

  it('returns a warning string when teamSize exceeds recommendedMax', () => {
    const warn = teamSizeWarningMessage('blackboard', 4);
    expect(warn).toBeDefined();
    expect(warn).toMatch(/teamSize=4/);
    expect(warn).toMatch(/recommendedMax=2/);
    expect(warn).toMatch(/blackboard/);
  });

  it('warns above recommendedMax for any pattern', () => {
    expect(teamSizeWarningMessage('orchestrator-worker', 4)).toBeDefined();
    expect(teamSizeWarningMessage('debate-judge', 3)).toBeDefined();
  });

  it('critic-loop is hard-capped at 2 by route validator', () => {
    expect(teamSizeWarningMessage('critic-loop', 2)).toBeUndefined();
    expect(teamSizeWarningMessage('critic-loop', 3)).toMatch(/recommendedMax=2/);
  });
});