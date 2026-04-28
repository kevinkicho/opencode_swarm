// @vitest-environment jsdom

// Form-helper tests for the new-run modal. The two regression-risky
// surfaces are extractRepoName (parses GitHub URLs into folder names)
// and the useNewRunForm clamping/removal logic for team counts.
//
// Per `feedback_right_size_prototype.md` we test only the bits where a
// silent regression would actually hurt: the URL parser feeds the cloning
// path, and a misclamped team count would let the user spawn 13+ agents
// (over the recommended ceiling). Everything else in the form is trivial
// or already covered by Playwright probes.

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { extractRepoName, generateRunId } from '../helpers';
import { useNewRunForm } from '../use-new-run-form';

describe('extractRepoName', () => {
  it('returns empty string for empty input', () => {
    expect(extractRepoName('')).toBe('');
    expect(extractRepoName('   ')).toBe('');
  });

  it('strips trailing .git', () => {
    expect(extractRepoName('https://github.com/anthropic/claude-cli.git')).toBe('claude-cli');
  });

  it('strips trailing slash', () => {
    expect(extractRepoName('https://github.com/anthropic/claude-cli/')).toBe('claude-cli');
  });

  it('handles plain repo name without protocol', () => {
    expect(extractRepoName('claude-cli')).toBe('claude-cli');
  });

  it('handles SSH-style URL', () => {
    expect(extractRepoName('git@github.com:anthropic/claude-cli.git')).toBe('claude-cli');
  });

  it('handles paths with multiple slashes', () => {
    expect(extractRepoName('https://gitlab.com/group/subgroup/project')).toBe('project');
  });

  it('does not break on URLs with branch suffix', () => {
    // The modal accepts "<url>#branch" syntactically; extractRepoName
    // doesn't strip the fragment — that's the branch parser's job. We
    // just verify it doesn't crash and returns the last segment.
    const out = extractRepoName('https://github.com/foo/bar#main');
    expect(out).toBe('bar#main');
  });
});

describe('generateRunId', () => {
  it('produces a swarm-prefixed 6-char id', () => {
    for (let i = 0; i < 10; i += 1) {
      const id = generateRunId();
      expect(id).toMatch(/^swarm-[a-z0-9]{6}$/);
    }
  });

  it('produces distinct ids on consecutive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) ids.add(generateRunId());
    // 50 calls × 36^6 codespace → near-zero chance of collision; we
    // accept some flake tolerance and just assert > 40 unique.
    expect(ids.size).toBeGreaterThan(40);
  });
});

describe('useNewRunForm', () => {
  it('clamps team count between 0 and 12', () => {
    const { result } = renderHook(() => useNewRunForm());

    act(() => result.current.setTeamCount('opencode/glm-4.6', 5));
    expect(result.current.form.teamCounts['opencode/glm-4.6']).toBe(5);

    // Over the cap → clamped to 12
    act(() => result.current.setTeamCount('opencode/glm-4.6', 50));
    expect(result.current.form.teamCounts['opencode/glm-4.6']).toBe(12);

    // Negative → clamped to 0 → entry removed
    act(() => result.current.setTeamCount('opencode/glm-4.6', -3));
    expect(result.current.form.teamCounts['opencode/glm-4.6']).toBeUndefined();
  });

  it('removes the entry when bumped down to 0', () => {
    const { result } = renderHook(() => useNewRunForm());

    act(() => result.current.bumpTeamCount('m1', 2));
    expect(result.current.form.teamCounts.m1).toBe(2);

    act(() => result.current.bumpTeamCount('m1', -2));
    expect(result.current.form.teamCounts.m1).toBeUndefined();
  });

  it('bumpTeamCount honors the clamp ceiling', () => {
    const { result } = renderHook(() => useNewRunForm());
    act(() => result.current.setTeamCount('m1', 12));
    act(() => result.current.bumpTeamCount('m1', 5));
    expect(result.current.form.teamCounts.m1).toBe(12);
  });

  it('clearTeam resets only teamCounts, not other fields', () => {
    const { result } = renderHook(() => useNewRunForm());
    act(() => result.current.setField('sourceValue', 'https://github.com/foo/bar'));
    act(() => result.current.setTeamCount('m1', 3));
    act(() => result.current.setTeamCount('m2', 1));
    expect(Object.keys(result.current.form.teamCounts)).toHaveLength(2);

    act(() => result.current.clearTeam());
    expect(result.current.form.teamCounts).toEqual({});
    // Other fields must survive
    expect(result.current.form.sourceValue).toBe('https://github.com/foo/bar');
  });

  it('reset returns the form to its initial state', () => {
    const { result } = renderHook(() => useNewRunForm());
    act(() => result.current.setField('sourceValue', 'foo'));
    act(() => result.current.setField('directive', 'hello'));
    act(() => result.current.setTeamCount('m1', 2));
    act(() => result.current.setField('costCap', 99));

    act(() => result.current.reset());
    expect(result.current.form.sourceValue).toBe('');
    expect(result.current.form.directive).toBe('');
    expect(result.current.form.teamCounts).toEqual({});
    expect(result.current.form.costCap).toBe(5); // initial default
    // branchName regenerates each reset (the swarm-XXXXXX form is randomized)
    expect(result.current.form.branchName).toMatch(/^swarm-[a-z0-9]{6}$/);
  });
});
