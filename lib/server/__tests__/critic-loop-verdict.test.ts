import { describe, expect, it } from 'vitest';
import { classifyCriticReply } from '../critic-loop';

// classifyCriticReply parses the critic session's reply into a structured
// verdict the orchestrator branches on. The contract has two layers:
//   1. YAML block (the I1 structured contract — verdict / confidence /
//      scope / issues bullets) — preferred path
//   2. Legacy first-line keyword check (APPROVED / REVISE) for older
//      critic prompts that don't emit yaml
//
// Drift here silently breaks the critic loop: an APPROVED that's read
// as 'unclear' loops the worker forever; a REVISE that's read as
// 'approved' ships unfinished work. Worth locking down.

describe('classifyCriticReply — yaml structured contract', () => {
  it('parses APPROVED with confidence', () => {
    const text = '```yaml\nverdict: APPROVED\nconfidence: 4\n```';
    const v = classifyCriticReply(text);
    expect(v.verdict).toBe('approved');
    expect(v.confidence).toBe(4);
    expect(v.scope).toBe('NONE');
  });

  it('parses REVISE with scope=STRUCTURAL', () => {
    const text = [
      '```yaml',
      'verdict: REVISE',
      'confidence: 3',
      'scope: STRUCTURAL',
      'issues:',
      '  - missing edge case for empty input',
      '  - return type drifts on error path',
      '```',
    ].join('\n');
    const v = classifyCriticReply(text);
    expect(v.verdict).toBe('revise');
    expect(v.confidence).toBe(3);
    expect(v.scope).toBe('STRUCTURAL');
    expect(v.issues).toEqual([
      'missing edge case for empty input',
      'return type drifts on error path',
    ]);
  });

  it('parses REVISE scope=WORDING (nitpick territory)', () => {
    const text = [
      '```yaml',
      'verdict: REVISE',
      'confidence: 2',
      'scope: WORDING',
      'issues:',
      '  - typo in line 4',
      '```',
    ].join('\n');
    const v = classifyCriticReply(text);
    expect(v.verdict).toBe('revise');
    expect(v.scope).toBe('WORDING');
    expect(v.confidence).toBe(2);
  });

  it('REVISE body composes issues + trailing prose for the worker', () => {
    const text = [
      '```yaml',
      'verdict: REVISE',
      'confidence: 3',
      'scope: STRUCTURAL',
      'issues:',
      '  - missing null guard',
      '```',
      '',
      'Specifically, line 12 dereferences without checking.',
    ].join('\n');
    const v = classifyCriticReply(text);
    // The body should contain both the structured issue and the trailing prose
    expect(v.body).toContain('missing null guard');
    expect(v.body).toContain('line 12 dereferences');
  });

  it('falls back to confidence=0 when missing', () => {
    const text = '```yaml\nverdict: APPROVED\n```';
    const v = classifyCriticReply(text);
    expect(v.verdict).toBe('approved');
    expect(v.confidence).toBe(0);
  });

  it('accepts ```yml (3-letter) fence in addition to ```yaml', () => {
    const text = '```yml\nverdict: APPROVED\nconfidence: 5\n```';
    const v = classifyCriticReply(text);
    expect(v.verdict).toBe('approved');
    expect(v.confidence).toBe(5);
  });
});

describe('classifyCriticReply — legacy first-line fallback', () => {
  it('approves on bare "APPROVED" first line (no yaml)', () => {
    const v = classifyCriticReply('APPROVED — looks good');
    expect(v.verdict).toBe('approved');
    expect(v.confidence).toBe(0); // no yaml = unknown confidence
  });

  it('revises on bare "REVISE:" prefix (no yaml)', () => {
    const v = classifyCriticReply('REVISE: missing tests for the error path');
    expect(v.verdict).toBe('revise');
    expect(v.scope).toBe('WORDING'); // legacy fallback default
    expect(v.body).toBe('missing tests for the error path');
  });

  it('case-insensitive match on first line', () => {
    expect(classifyCriticReply('approved').verdict).toBe('approved');
    expect(classifyCriticReply('Approved\n').verdict).toBe('approved');
    expect(classifyCriticReply('revise me').verdict).toBe('revise');
  });

  it('returns unclear on neither keyword', () => {
    const v = classifyCriticReply('looks alright but I have some thoughts');
    expect(v.verdict).toBe('unclear');
    expect(v.body).toBe('looks alright but I have some thoughts');
  });
});
