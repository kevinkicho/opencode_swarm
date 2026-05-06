import { describe, expect, it } from 'vitest';
import {
  classifyCriticReply,
  buildWorkerIntroPrompt,
  buildCriticIntroPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
} from '../critic-loop/parsers';

describe('critic-loop parsers', () => {
  describe('classifyCriticReply', () => {
    it('parses YAML APPROVED verdict', () => {
      const text = '```yaml\nverdict: APPROVED\nconfidence: 5\nscope: NONE\nissues:\n  - none\n```';
      const v = classifyCriticReply(text);
      expect(v.verdict).toBe('approved');
      expect(v.confidence).toBe(5);
      expect(v.scope).toBe('NONE');
    });

    it('parses YAML REVISE verdict with issues', () => {
      const text = '```yaml\nverdict: REVISE\nconfidence: 3\nscope: STRUCTURAL\nissues:\n  - missing error handling\n  - no tests\n```\nPlease add proper error handling.';
      const v = classifyCriticReply(text);
      expect(v.verdict).toBe('revise');
      expect(v.confidence).toBe(3);
      expect(v.scope).toBe('STRUCTURAL');
      expect(v.issues).toEqual(['missing error handling', 'no tests']);
      expect(v.body).toContain('Please add proper error handling');
    });

    it('falls back to first-line keyword APPROVED', () => {
      const v = classifyCriticReply('APPROVED — looks good');
      expect(v.verdict).toBe('approved');
      expect(v.confidence).toBe(0);
    });

    it('falls back to first-line keyword REVISE', () => {
      const v = classifyCriticReply('REVISE: fix the error handling');
      expect(v.verdict).toBe('revise');
      expect(v.scope).toBe('WORDING');
    });

    it('classifies unclear when no keyword found', () => {
      const v = classifyCriticReply('I am uncertain about this draft.');
      expect(v.verdict).toBe('unclear');
      expect(v.body).toBeTruthy();
    });
  });

  describe('buildWorkerIntroPrompt', () => {
    it('includes the directive', () => {
      const p = buildWorkerIntroPrompt('Implement the login flow');
      expect(p).toContain('Implement the login flow');
      expect(p).toContain('worker');
    });

    it('uses fallback when directive is undefined', () => {
      const p = buildWorkerIntroPrompt(undefined);
      expect(p).toContain('project README');
    });
  });

  describe('buildCriticIntroPrompt', () => {
    it('includes the directive', () => {
      const p = buildCriticIntroPrompt('Review the login implementation');
      expect(p).toContain('Review the login implementation');
      expect(p).toContain('critic');
    });

    it('includes the YAML contract', () => {
      const p = buildCriticIntroPrompt('test');
      expect(p).toContain('APPROVED');
      expect(p).toContain('REVISE');
      expect(p).toContain('confidence');
    });
  });

  describe('buildReviewPrompt', () => {
    it('includes round and draft', () => {
      const p = buildReviewPrompt('Here is my draft code', 2);
      expect(p).toContain('Round 2');
      expect(p).toContain('Here is my draft code');
    });
  });

  describe('buildRevisionPrompt', () => {
    it('includes round numbers and feedback', () => {
      const p = buildRevisionPrompt('Fix error handling', 3, 5);
      expect(p).toContain('Round 3 of 5');
      expect(p).toContain('Fix error handling');
    });
  });
});