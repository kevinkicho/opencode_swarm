import { describe, expect, it } from 'vitest';
import {
  parseCriticVerdict,
  buildCriticPrompt,
  buildSynthesisPrompt,
  truncateDraftForSynthesis,
  buildSynthesisRevisePrompt,
  pickCriticSession,
} from '../map-reduce/parsers';

describe('map-reduce parsers', () => {
  describe('parseCriticVerdict', () => {
    it('detects APPROVED', () => {
      const v = parseCriticVerdict('APPROVED\nLooks good to me.');
      expect(v.verdict).toBe('approved');
      expect(v.feedback).toBe('');
    });

    it('detects REVISE with feedback', () => {
      const v = parseCriticVerdict('REVISE\nThe error handling is incomplete.');
      expect(v.verdict).toBe('revise');
      expect(v.feedback).toContain('error handling is incomplete');
    });

    it('is case-insensitive for APPROVED', () => {
      const v = parseCriticVerdict('approved\nGreat work.');
      expect(v.verdict).toBe('approved');
    });

    it('returns unclear for unrecognized text', () => {
      const v = parseCriticVerdict('something unexpected');
      expect(v.verdict).toBe('unclear');
    });
  });

  describe('truncateDraftForSynthesis', () => {
    it('passes through short drafts', () => {
      const out = truncateDraftForSynthesis('short text');
      expect(out.text).toBe('short text');
      expect(out.truncated).toBe(false);
    });

    it('truncates long drafts', () => {
      const long = 'z'.repeat(200_000);
      const out = truncateDraftForSynthesis(long);
      expect(out.truncated).toBe(true);
      expect(out.text.length).toBeLessThan(long.length);
    });

    it('includes truncation marker', () => {
      const long = 'z'.repeat(200_000);
      const out = truncateDraftForSynthesis(long);
      expect(out.text).toMatch(/truncat/i);
    });
  });

  describe('buildSynthesisPrompt', () => {
    it('includes member drafts', () => {
      const p = buildSynthesisPrompt(
        [{ sessionID: 's1', text: 'draft one' }, { sessionID: 's2', text: 'draft two' }],
        'Build the API',
      );
      expect(p).toContain('draft one');
      expect(p).toContain('draft two');
      expect(p).toContain('Build the API');
    });

    it('notes failed sessions when failedCount > 0', () => {
      const p = buildSynthesisPrompt(
        [{ sessionID: 's1', text: 'ok' }],
        'Directive',
        2,
      );
      expect(p).toMatch(/2.*did not produce/i);
    });
  });

  describe('pickCriticSession', () => {
    it('picks a session that is not the synthesizer', () => {
      const result = pickCriticSession(['s2', 's3'], 's1');
      expect(result).toBeTruthy();
      expect(result).not.toBe('s1');
    });

    it('returns null when no peers exist', () => {
      expect(pickCriticSession([], 's1')).toBeNull();
    });

    it('returns null when only the synthesizer is in the list', () => {
      expect(pickCriticSession(['s1'], 's1')).toBeNull();
    });
  });

  describe('buildCriticPrompt', () => {
    it('includes synthesis text and member drafts', () => {
      const p = buildCriticPrompt('synthesis output', [
        { sessionID: 's1', text: 'draft a' },
        { sessionID: 's2', text: 'draft b' },
      ]);
      expect(p).toContain('synthesis output');
      expect(p).toContain('APPROVED');
      expect(p).toContain('REVISE');
    });
  });

  describe('buildSynthesisRevisePrompt', () => {
    it('includes feedback and attempt info', () => {
      const p = buildSynthesisRevisePrompt('Fix the types', 2, 3);
      expect(p).toContain('Fix the types');
      expect(p).toMatch(/2.*3/);
    });
  });
});