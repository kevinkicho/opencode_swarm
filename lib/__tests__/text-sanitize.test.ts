import { describe, expect, it } from 'vitest';
import { stripProtocolTokens } from '../text-sanitize';

describe('stripProtocolTokens', () => {
  it('passes through plain text unchanged', () => {
    expect(stripProtocolTokens('Hello, world.')).toBe('Hello, world.');
  });

  it('strips qwen tool-call markers', () => {
    expect(
      stripProtocolTokens(
        'Result <|tool_call_begin|>fn(x)<|tool_call_end|> done',
      ),
    ).toBe('Result fn(x) done');
  });

  it('strips im_start and im_end', () => {
    expect(stripProtocolTokens('<|im_start|>system<|im_end|>')).toBe('system');
  });

  it('strips fim markers', () => {
    expect(
      stripProtocolTokens('<|fim_prefix|>code<|fim_middle|>more<|fim_suffix|>'),
    ).toBe('codemore');
  });

  it('strips endoftext markers', () => {
    expect(
      stripProtocolTokens('Some text<|endoftext|>'),
    ).toBe('Some text');
  });

  it('preserves markdown pipe tables (no false positives)', () => {
    const table = '| col | content |\n| --- | --- |\n| a | b |';
    expect(stripProtocolTokens(table)).toBe(table);
  });

  it('preserves code with vertical bars in regex', () => {
    const code = 'const re = /a|b|c/g;';
    expect(stripProtocolTokens(code)).toBe(code);
  });

  it('handles empty input', () => {
    expect(stripProtocolTokens('')).toBe('');
  });

  it('strips multiple occurrences in one string', () => {
    expect(
      stripProtocolTokens(
        '<|tool_call_begin|>a<|tool_call_end|> middle <|im_start|>b<|im_end|>',
      ),
    ).toBe('a middle b');
  });
});
