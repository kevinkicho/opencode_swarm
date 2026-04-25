import { describe, expect, it } from 'vitest';
import {
  buildWorkPrompt,
  extractRetryFailureReason,
} from '../coordinator';
import type { BoardItem } from '../../../blackboard/types';

const baseTodo: BoardItem = {
  id: 't_001',
  kind: 'todo',
  content: 'Wire the dispatch watchdog into planner sweep',
  status: 'open',
  createdAtMs: 0,
};

describe('extractRetryFailureReason', () => {
  it('returns null for empty / null / undefined notes', () => {
    expect(extractRetryFailureReason(null)).toBeNull();
    expect(extractRetryFailureReason(undefined)).toBeNull();
    expect(extractRetryFailureReason('')).toBeNull();
  });

  it('returns null when no retry tag present', () => {
    expect(extractRetryFailureReason('waiting on t_002')).toBeNull();
  });

  it('parses [retry:N] reason notes', () => {
    expect(extractRetryFailureReason('[retry:1] turn timed out')).toEqual({
      attempt: 1,
      reason: 'turn timed out',
    });
    expect(
      extractRetryFailureReason('[retry:2] prompt-send failed: ECONNRESET'),
    ).toEqual({ attempt: 2, reason: 'prompt-send failed: ECONNRESET' });
  });

  it('handles retry tag with empty reason', () => {
    expect(extractRetryFailureReason('[retry:1] ')).toEqual({
      attempt: 1,
      reason: '(no reason recorded)',
    });
  });
});

describe('buildWorkPrompt — retry differentiation (#76)', () => {
  it('first attempt has no retry preamble', () => {
    const prompt = buildWorkPrompt(baseTodo);
    expect(prompt).not.toContain('this is retry');
    expect(prompt).toContain('Todo: Wire the dispatch watchdog');
  });

  it('retry attempt injects previous-failure preamble', () => {
    const retried: BoardItem = {
      ...baseTodo,
      note: '[retry:1] turn timed out',
    };
    const prompt = buildWorkPrompt(retried);
    expect(prompt).toContain('this is retry 1');
    expect(prompt).toContain('turn timed out');
    expect(prompt).toContain('Do not just repeat the previous attempt');
  });

  it('attempt N is surfaced for higher retry counts', () => {
    const retried: BoardItem = {
      ...baseTodo,
      note: '[retry:2] prompt-send failed: ECONNRESET',
    };
    const prompt = buildWorkPrompt(retried);
    expect(prompt).toContain('this is retry 2');
    expect(prompt).toContain('ECONNRESET');
  });

  it('synthesize items are posted verbatim (no retry preamble)', () => {
    const synth: BoardItem = {
      ...baseTodo,
      kind: 'synthesize',
      content: '## synthesis prompt body',
      note: '[retry:1] timeout',
    };
    expect(buildWorkPrompt(synth)).toBe('## synthesis prompt body');
  });
});
