import { describe, expect, it } from 'vitest';
import { meanPairwiseJaccard } from '../council';

// meanPairwiseJaccard powers the council I1 auto-stop convergence
// detection. When the mean pairwise jaccard similarity between member
// drafts crosses COUNCIL_CONVERGENCE_THRESHOLD (0.55 in council.ts),
// the orchestrator auto-stops remaining rounds — the room has agreed
// enough. Drift here either keeps spending tokens past convergence
// (high false-negative) or stops while members still genuinely
// disagree (high false-positive). Both wreck the pattern's value.

describe('meanPairwiseJaccard — convergence math', () => {
  it('returns null for fewer than 2 texts', () => {
    expect(meanPairwiseJaccard([])).toBeNull();
    expect(meanPairwiseJaccard(['only one'])).toBeNull();
  });

  it('returns 1.0 when texts are identical', () => {
    const sim = meanPairwiseJaccard([
      'we should refactor the auth module first',
      'we should refactor the auth module first',
    ]);
    expect(sim).toBe(1);
  });

  it('returns 0 when texts share no meaningful tokens', () => {
    const sim = meanPairwiseJaccard([
      'authentication module security migration',
      'frontend rendering performance memoization',
    ]);
    expect(sim).toBe(0);
  });

  it('returns intermediate value for partial overlap', () => {
    const sim = meanPairwiseJaccard([
      'refactor authentication module first then proceed',
      'refactor authentication strategy first then deploy',
    ]);
    // Both share "refactor", "authentication", "first", "then" — not
    // identical but overlap meaningfully.
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(1);
  });

  it('averages over pairwise comparisons (3+ members)', () => {
    // 3 members: 3 pairs. Identical 1+2, totally disjoint 3.
    // Expected mean: (1.0 + 0.0 + 0.0) / 3 ≈ 0.33
    const sim = meanPairwiseJaccard([
      'authentication module migration plan',
      'authentication module migration plan',
      'frontend rendering performance memoization',
    ]);
    expect(sim).toBeGreaterThan(0.25);
    expect(sim).toBeLessThan(0.4);
  });

  it('skips empty texts via filter(Boolean)', () => {
    // Two real + one empty = pairwise just over the two real ones.
    // The function filters before tokenizing, so the empty string drops out.
    const sim = meanPairwiseJaccard([
      'authentication module migration plan',
      'authentication module migration plan',
      '',
    ]);
    expect(sim).toBe(1);
  });

  it('returns null when only short / non-meaningful tokens exist', () => {
    // Tokens under the convergence-tokenizer threshold are dropped.
    // Two empty token-sets means no meaningful comparison.
    const sim = meanPairwiseJaccard(['a b c', 'd e f']);
    // Both texts tokenize to empty sets (tokens too short) — pair skipped.
    expect(sim).toBeNull();
  });
});
