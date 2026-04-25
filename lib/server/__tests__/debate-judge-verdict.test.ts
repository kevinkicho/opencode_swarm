import { describe, expect, it } from 'vitest';
import {
  classifyJudgeReply,
  bulletAddressedFraction,
} from '../debate-judge';

// classifyJudgeReply parses the judge session's reply into a verdict
// that drives the orchestrator: WINNER / MERGE = debate complete,
// REVISE = fan revision prompt to all generators for next round.
// Drift here either ships unfinished output (verdict=winner read as
// revise) or burns rounds chasing a settled debate (the inverse).

describe('classifyJudgeReply — verdicts', () => {
  it('WINNER on first-line keyword', () => {
    const v = classifyJudgeReply(
      'WINNER: Generator 2 — clearer architectural separation',
    );
    expect(v.verdict).toBe('winner');
  });

  it('MERGE on first-line keyword', () => {
    const v = classifyJudgeReply(
      'MERGE: combine generator 1 and 3 — frontend from G1, backend from G3',
    );
    expect(v.verdict).toBe('merge');
  });

  it('REVISE strips the prefix and returns trailing body', () => {
    const text = 'REVISE: \n- generator 1: missing test plan\n- generator 2: contradictory invariants';
    const v = classifyJudgeReply(text);
    expect(v.verdict).toBe('revise');
    expect(v.body).toContain('missing test plan');
    expect(v.body).toContain('contradictory invariants');
  });

  it('returns unclear on neither keyword', () => {
    const v = classifyJudgeReply('these are all great proposals, hard to pick');
    expect(v.verdict).toBe('unclear');
  });

  it('parses confidence from the WINNER line when present', () => {
    const v = classifyJudgeReply(
      'WINNER: Generator 1 (confidence: 4/5) — best-balanced trade-off',
    );
    expect(v.verdict).toBe('winner');
    expect(v.confidence).toBe(4);
  });

  it('confidence is null for REVISE verdicts', () => {
    const v = classifyJudgeReply('REVISE:\n- generator 2: clarify the migration path');
    expect(v.verdict).toBe('revise');
    expect(v.confidence).toBeNull();
  });

  it('REVISE without per-generator structure leaves bullets empty', () => {
    const v = classifyJudgeReply('REVISE: try again with more detail');
    expect(v.verdict).toBe('revise');
    expect(v.bulletsByGenerator.size).toBe(0);
  });

  it('REVISE with per-generator structure populates bullets map', () => {
    // The judge's I1 contract: per-generator subsections with bullets.
    const text = [
      'REVISE:',
      '',
      'Generator 1:',
      '  - missing migration plan',
      '  - unclear rollback strategy',
      '',
      'Generator 2:',
      '  - performance unaddressed',
    ].join('\n');
    const v = classifyJudgeReply(text);
    expect(v.verdict).toBe('revise');
    expect(v.bulletsByGenerator.get(1)?.length).toBe(2);
    expect(v.bulletsByGenerator.get(2)?.length).toBe(1);
    expect(v.bulletsByGenerator.get(1)?.[0]).toContain('migration plan');
  });
});

describe('bulletAddressedFraction — I2 feedback engagement', () => {
  it('returns 1.0 when bullets are empty (nothing to address)', () => {
    expect(bulletAddressedFraction('any text', [])).toBe(1);
  });

  it('returns 1.0 when proposal directly addresses every bullet', () => {
    // Short proposal so tokens overlap densely with bullet tokens.
    // Jaccard threshold for "addressed" is 0.10 (against UNION), so the
    // proposal can't be much longer than the bullets without diluting.
    const proposal = 'migration plan rollback strategy revised';
    const bullets = ['migration plan', 'rollback strategy'];
    const frac = bulletAddressedFraction(proposal, bullets);
    expect(frac).toBe(1);
  });

  it('returns 0 when proposal ignores all bullets (no token overlap)', () => {
    const proposal = 'frontend rendering performance memoization tweaks';
    const bullets = ['migration plan', 'rollback strategy'];
    const frac = bulletAddressedFraction(proposal, bullets);
    expect(frac).toBe(0);
  });

  it('returns 0.5 when proposal addresses one of two bullets', () => {
    // Both bullet tokens for "migration plan" appear in the proposal,
    // but neither "rollback" nor "strategy" do.
    const proposal = 'migration plan revised';
    const bullets = ['migration plan', 'rollback strategy'];
    const frac = bulletAddressedFraction(proposal, bullets);
    expect(frac).toBe(0.5);
  });

  it('case-insensitive matching', () => {
    const frac = bulletAddressedFraction(
      'MIGRATION script ready',
      ['migration plan'],
    );
    expect(frac).toBe(1);
  });

  it('skips short tokens (< 4 chars)', () => {
    // "the" / "is" / "a" don't count toward intersection — matches must
    // be on meaningful tokens. So a proposal with only stopwords gets 0.
    const frac = bulletAddressedFraction(
      'the is a',
      ['the migration plan'],
    );
    // Bullet has "migration" + "plan" (4-letter tokens); proposal has only stopwords.
    expect(frac).toBe(0);
  });
});
