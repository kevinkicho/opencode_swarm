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

  // Class B: pseudo-XML tool calls
  it('strips pseudo-XML tool blocks with nested command/description', () => {
    expect(
      stripProtocolTokens(
        'I will start by reading the file.\n\n<tool>Bash\n<command>find . -name "*.ts"</command>\n<description>Find TypeScript files</description>\n</tool>',
      ),
    ).toBe('I will start by reading the file.');
  });

  it('strips self-closing pseudo-XML tool tags', () => {
    expect(
      stripProtocolTokens(
        "Let me check.\n\n<read path='src/index.ts'></read>\n\nDone.",
      ),
    ).toBe('Let me check.\n\nDone.');
  });

  it('strips self-closing short-form pseudo-XML tags', () => {
    expect(
      stripProtocolTokens(
        '<grep pattern="export" path="lib/" />\n\nFound 3 matches.',
      ),
    ).toBe('Found 3 matches.');
  });

  it('strips tool|> pipe-close pseudo tags', () => {
    expect(
      stripProtocolTokens(
        'Result<tool|>\nSome content\n</tool|>More text',
      ),
    ).toBe('Result\nSome content\nMore text');
  });

  it('strips find-files pseudo tags', () => {
    expect(
      stripProtocolTokens(
        '<find-files pattern="**/*.test.*" directory="/workspace" />\n\nRunning tests...',
      ),
    ).toBe('Running tests...');
  });

  it('strips list pseudo tags', () => {
    expect(
      stripProtocolTokens("<list path='.' />\n\nHere are the files."),
    ).toBe('Here are the files.');
  });

  it('collapses excessive whitespace after stripping', () => {
    expect(
      stripProtocolTokens(
        'Start\n\n<tool>Bash\n<command>ls</command>\n</tool>\n\n\n\nEnd',
      ),
    ).toBe('Start\n\nEnd');
  });

  it('does not strip real HTML tags like <div> or <code>', () => {
    expect(stripProtocolTokens('<div>Hello</div>')).toBe('<div>Hello</div>');
  });

  it('handles mixed Class A and Class B markers', () => {
    expect(
      stripProtocolTokens(
        '<|im_start|>user<|im_end|>\n<read path="foo.ts"></read>\nHere is the code.',
      ),
    ).toBe('user\n\nHere is the code.');
  });
});
