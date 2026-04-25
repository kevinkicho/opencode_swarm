import { describe, expect, it } from 'vitest';
import {
  classifyDirectiveComplexity,
  classifySynthesisReply,
} from '../deliberate-execute';

// classifyDirectiveComplexity powers the I4 directive-complexity
// WARN. Deliberate-execute pays for a richer mental model in tokens
// (N sessions × N rounds before any code lands), so for trivial
// directives the cost outweighs the benefit. The classifier is
// inform-only (we don't auto-redirect); just surfaces the signal so
// the operator can rethink next time.
//
// Drift here either nags on legitimately substantial directives
// (false positive — operator ignores warnings, real signal lost) or
// stays quiet on trivial ones (false negative — bias persists).

describe('classifyDirectiveComplexity', () => {
  it('flags a tiny directive as small', () => {
    const out = classifyDirectiveComplexity('add a button');
    expect(out.small).toBe(true);
    expect(out.charCount).toBeLessThan(200);
    expect(out.verbCount).toBeLessThanOrEqual(2);
    expect(out.verbs).toContain('add');
  });

  it('does NOT flag a substantial multi-verb directive', () => {
    const directive =
      'audit the auth module, refactor session handling, write integration tests, document the new contract, deploy to staging';
    const out = classifyDirectiveComplexity(directive);
    expect(out.small).toBe(false);
    expect(out.verbCount).toBeGreaterThanOrEqual(3);
  });

  it('counts only canonical action verbs from the curated list', () => {
    const out = classifyDirectiveComplexity('build refactor deploy ');
    expect(out.verbs.sort()).toEqual(['build', 'deploy', 'refactor']);
    expect(out.verbCount).toBe(3);
  });

  it('dedupes repeated verbs', () => {
    const out = classifyDirectiveComplexity('test test test it');
    expect(out.verbs).toContain('test');
    // Even with three "test"s the verbCount stays at 1 (Set dedupes).
    expect(out.verbCount).toBe(1);
  });

  it('counts char count after trim', () => {
    const out = classifyDirectiveComplexity('   hi   ');
    expect(out.charCount).toBe(2);
  });

  it('long directive with low verb count = NOT small (chars trip threshold)', () => {
    // 250 chars, only 1 action verb. small = (chars < 200 AND verbs ≤ 2).
    // Char count fails → not small.
    const directive =
      'add a thoughtful and well-documented button to the dashboard, with a clear hover state and an accessible aria label, plus a smooth transition that respects the user\'s prefers-reduced-motion media query setting';
    const out = classifyDirectiveComplexity(directive);
    expect(out.charCount).toBeGreaterThanOrEqual(200);
    expect(out.small).toBe(false);
  });

  it('strips punctuation when extracting verbs', () => {
    // Without punctuation stripping, "add," wouldn't match "add".
    const out = classifyDirectiveComplexity('add, build, deploy.');
    expect(out.verbs.sort()).toEqual(['add', 'build', 'deploy']);
  });
});

// classifySynthesisReply parses the synthesis-verifier reply (I1) on
// deliberate-execute. APPROVED → seed todos and proceed. REVISE →
// clear seeded items, post the verifier's feedback to the synthesizer,
// re-synthesize. UNCLEAR → treat as approve (don't loop forever).

describe('classifySynthesisReply — I1 verifier verdict', () => {
  it('APPROVED on first-line keyword', () => {
    const v = classifySynthesisReply('APPROVED: todos look concrete and independent');
    expect(v.verdict).toBe('approved');
  });

  it('REVISE on first-line keyword strips the prefix', () => {
    const v = classifySynthesisReply(
      'REVISE:\n  - todo 3 is too vague\n  - todo 5 depends on todo 2',
    );
    expect(v.verdict).toBe('revise');
    expect(v.feedback).toContain('todo 3 is too vague');
    expect(v.feedback).not.toMatch(/^revise/i);
  });

  it('returns unclear on neither keyword', () => {
    const v = classifySynthesisReply('these todos look mostly OK to me');
    expect(v.verdict).toBe('unclear');
  });

  it('case-insensitive first-line keyword match', () => {
    expect(classifySynthesisReply('approved').verdict).toBe('approved');
    expect(classifySynthesisReply('Revise: try again').verdict).toBe('revise');
  });

  it('preserves full text in feedback for APPROVED (operator may want it)', () => {
    const text = 'APPROVED: solid todos\n\nnice job on the file scoping';
    const v = classifySynthesisReply(text);
    expect(v.feedback).toBe(text.trim());
  });
});
