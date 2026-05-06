import { describe, expect, it } from 'vitest';
import {
  classifyJudgeReply,
  parseConfidence,
  parseGeneratorBullets,
  bulletAddressedFraction,
  tokenizeForAddress,
  buildGeneratorIntroPrompt,
  buildJudgeIntroPrompt,
  buildJudgmentPrompt,
  buildRevisionPrompt,
} from '../debate-judge/parsers';

describe('debate-judge parsers', () => {
  describe('parseConfidence', () => {
    it('extracts K from "confidence: K/5"', () => {
      expect(parseConfidence('confidence: 4/5')).toBe(4);
    });

    it('extracts K from "confidence: K" without /5', () => {
      expect(parseConfidence('confidence: 3')).toBe(3);
    });

    it('extracts K from "confidence=K/5" with equals', () => {
      expect(parseConfidence('confidence=2/5')).toBe(2);
    });

    it('is case-insensitive', () => {
      expect(parseConfidence('Confidence: 5/5')).toBe(5);
    });

    it('returns null for no confidence line', () => {
      expect(parseConfidence('REVISE — generator-1:')).toBeNull();
    });

    it('returns null for out-of-range values', () => {
      expect(parseConfidence('confidence: 0/5')).toBeNull();
      expect(parseConfidence('confidence: 6/5')).toBeNull();
    });
  });

  describe('classifyJudgeReply', () => {
    it('classifies WINNER replies', () => {
      const v = classifyJudgeReply('WINNER: generator-1 (confidence: 4/5) — clear winner');
      expect(v.verdict).toBe('winner');
      expect(v.confidence).toBe(4);
    });

    it('classifies MERGE replies', () => {
      const v = classifyJudgeReply('MERGE: (confidence: 3/5) combined approach');
      expect(v.verdict).toBe('merge');
      expect(v.confidence).toBe(3);
    });

    it('classifies REVISE replies with bullets', () => {
      const text = `REVISE — generator-1:\n- fix the error handling\n- add tests`;
      const v = classifyJudgeReply(text);
      expect(v.verdict).toBe('revise');
      expect(v.bulletsByGenerator.size).toBeGreaterThan(0);
    });

    it('classifies unclear replies', () => {
      const v = classifyJudgeReply('I am not sure what to pick here.');
      expect(v.verdict).toBe('unclear');
      expect(v.confidence).toBeNull();
    });
  });

  describe('parseGeneratorBullets', () => {
    it('parses generator-sectioned bullet lists', () => {
      const text = `REVISE — generator-1:\n- fix error handling\n- add tests\n\nREVISE — generator-2:\n- improve naming`;
      const map = parseGeneratorBullets(text);
      expect(map.get(1)).toEqual(['fix error handling', 'add tests']);
      expect(map.get(2)).toEqual(['improve naming']);
    });

    it('returns empty map for text with no generator sections', () => {
      expect(parseGeneratorBullets('just some text')).toEqual(new Map());
    });
  });

  describe('tokenizeForAddress', () => {
    it('tokenizes words of length >= 4', () => {
      const tokens = tokenizeForAddress('Implement the database changes');
      expect(tokens.has('implement')).toBe(true);
      expect(tokens.has('database')).toBe(true);
      expect(tokens.has('changes')).toBe(true);
      expect(tokens.has('the')).toBe(false);
    });
  });

  describe('bulletAddressedFraction', () => {
    it('returns 1 when all bullets are addressed', () => {
      expect(bulletAddressedFraction('fix the error handling and add tests', ['fix error handling', 'add tests'])).toBe(1);
    });

    it('returns 0 when no bullets are addressed', () => {
      expect(bulletAddressedFraction('completely unrelated text', ['fix error handling', 'add tests'])).toBe(0);
    });

    it('returns 1 for empty bullets list', () => {
      expect(bulletAddressedFraction('any text', [])).toBe(1);
    });
  });

  describe('buildGeneratorIntroPrompt', () => {
    it('includes generator index and total', () => {
      const p = buildGeneratorIntroPrompt('Build the API', 1, 3);
      expect(p).toContain('generator 1 of 3');
      expect(p).toContain('Build the API');
    });

    it('uses fallback when directive is undefined', () => {
      const p = buildGeneratorIntroPrompt(undefined, 0, 2);
      expect(p).toContain('generator 0 of 2');
      expect(p).toContain('mission implied by the project README');
    });
  });

  describe('buildJudgeIntroPrompt', () => {
    it('includes generator count', () => {
      const p = buildJudgeIntroPrompt('Ship the feature', 3);
      expect(p).toContain('3 generators');
      expect(p).toContain('Ship the feature');
    });
  });

  describe('buildJudgmentPrompt', () => {
    it('includes round and max rounds', () => {
      const p = buildJudgmentPrompt([{ index: 1, text: 'proposal' }], 2, 5);
      expect(p).toContain('Round 2 of 5');
      expect(p).toContain('generator-1');
    });

    it('skips null drafts', () => {
      const p = buildJudgmentPrompt([{ index: 1, text: null }, { index: 2, text: 'real' }], 1, 3);
      expect(p).toContain('generator-2');
    });
  });

  describe('buildRevisionPrompt', () => {
    it('includes round numbers and feedback', () => {
      const p = buildRevisionPrompt('Fix the types', 3, 5);
      expect(p).toContain('Round 3 of 5');
      expect(p).toContain('Fix the types');
    });
  });
});