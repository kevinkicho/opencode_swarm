import { describe, it, expect } from 'vitest';
import { recommendPattern } from '../recommend-pattern';

describe('recommendPattern', () => {
  it('returns null for empty string', () => {
    expect(recommendPattern('')).toBeNull();
  });

  it('returns null for short strings below threshold', () => {
    expect(recommendPattern('fix bug')).toBeNull();
  });

  it('returns null for ambiguous text that hits no keyword buckets', () => {
    expect(recommendPattern('do something interesting with the dataset')).toBeNull();
  });

  it('recommends blackboard for implementation tasks', () => {
    expect(recommendPattern('Implement the following changes: add user auth, fix login bug, and update the dashboard')).toBe('blackboard');
  });

  it('recommends blackboard for batch bug fix directives', () => {
    expect(recommendPattern('Fix multiple bugs in the payment processing module and migrate to the new API')).toBe('blackboard');
  });

  it('recommends blackboard for independent parallel tasks', () => {
    expect(recommendPattern('Complete these independent tasks in parallel: add tests, remove deprecated endpoints, refactor utils')).toBe('blackboard');
  });

  it('recommends map-reduce for survey directives', () => {
    expect(recommendPattern('Survey the codebase and produce a comprehensive analysis of all error handling patterns')).toBe('map-reduce');
  });

  it('recommends map-reduce for find-all directives', () => {
    expect(recommendPattern('Find all files that import deprecated functions and catalog them')).toBe('map-reduce');
  });

  it('recommends council for comparison directives', () => {
    expect(recommendPattern('Compare approaches for the new authentication system: pros and cons of each')).toBe('council');
  });

  it('recommends council for design decisions', () => {
    expect(recommendPattern('Which approach should we use for the new caching layer? Evaluate options for the architecture decision')).toBe('council');
  });

  it('recommends debate-judge for evaluation directives', () => {
    expect(recommendPattern('Which is better for our use case: PostgreSQL or MongoDB? Judge the proposals and pick the best')).toBe('debate-judge');
  });

  it('recommends debate-judge for ranking/scoring', () => {
    expect(recommendPattern('Judge the three proposals and give a verdict on the best approach')).toBe('debate-judge');
  });

  it('recommends orchestrator-worker for end-to-end implementation', () => {
    expect(recommendPattern('Implement end-to-end the new payment processing pipeline from scratch')).toBe('orchestrator-worker');
  });

  it('recommends critic-loop for refinement tasks', () => {
    expect(recommendPattern('Refine the API documentation until the critic approves the quality')).toBe('critic-loop');
  });

  it('recommends critic-loop for iterative improvement', () => {
    expect(recommendPattern('Review and improve the onboarding prose — revise until it reads well')).toBe('critic-loop');
  });

  it('recommends pipeline for explore-then-execute', () => {
    expect(recommendPattern('Explore the codebase, then implement the new feature')).toBe('pipeline');
  });

  it('recommends pipeline for phased approaches', () => {
    expect(recommendPattern('First analyze the existing architecture, then fix the identified issues')).toBe('pipeline');
  });

  it('returns null when text is too short but contains keywords', () => {
    expect(recommendPattern('fix')).toBeNull();
    expect(recommendPattern('survey all')).toBeNull();
  });

  it('picks the highest-scoring pattern on ambiguous input', () => {
    // "analyze then implement" — both map-reduce and pipeline have keywords
    // but "then implement" is a strong pipeline signal (weight 4)
    const result = recommendPattern('Analyze the architecture then implement the changes');
    expect(result).toBe('pipeline');
  });

  it('does not match substrings for single-word keywords', () => {
    // "prefix" should NOT match the "fix" keyword
    const result = recommendPattern('Add a prefix to all CSS class names in the components');
    // This only hits "add" (weight 1 in blackboard) — not enough to cross threshold
    expect(result).toBeNull();
  });

  it('matches multi-word phrases as substrings', () => {
    // "which approach is better" should match "which is better" partially
    // but "which approach" is weight 4 in council
    const result = recommendPattern('Which approach should we take for the data pipeline?');
    expect(result).toBe('council');
  });
});