import { describe, expect, it } from 'vitest';
import { detectSemanticLoop } from '../semantic-loop';
import type { OpencodeMessage, OpencodePart } from '../../opencode/types';

function makeMsg(parts: OpencodePart[], role: 'assistant' | 'user' = 'assistant'): OpencodeMessage {
  return {
    info: { id: `msg-${Math.random()}`, role, time: { created: Date.now(), completed: Date.now() } },
    parts,
  } as OpencodeMessage;
}

function patchPart(files: string[]): OpencodePart {
  return { type: 'patch', files, hash: `h-${Math.random()}` } as OpencodePart;
}

function todoPart(todos: Array<{ content: string; status: string }>): OpencodePart {
  return {
    type: 'tool',
    tool: 'todowrite',
    state: { input: { todos } },
  } as unknown as OpencodePart;
}

function reasoningPart(text: string): OpencodePart {
  return { type: 'reasoning', text } as OpencodePart;
}

describe('detectSemanticLoop', () => {
  it('returns no detection for too few messages', () => {
    const result = detectSemanticLoop({ messages: [makeMsg([patchPart(['a.ts'])])] });
    expect(result.detected).toBe(false);
  });

  it('detects repeated edits to the same file', () => {
    const msgs = Array.from({ length: 4 }, () => makeMsg([patchPart(['src/index.ts'])]));
    const result = detectSemanticLoop({ messages: msgs });
    expect(result.detected).toBe(true);
    expect(result.reason).toContain('src/index.ts');
  });

  it('does not fire below threshold', () => {
    const msgs = Array.from({ length: 2 }, () => makeMsg([patchPart(['src/index.ts'])]));
    const result = detectSemanticLoop({ messages: msgs });
    expect(result.detected).toBe(false);
  });

  it('detects repeated todowrite plans', () => {
    const sameTodo = { content: 'Implement auth module', status: 'in_progress' };
    const msgs = Array.from({ length: 4 }, () => makeMsg([todoPart([sameTodo])]));
    const result = detectSemanticLoop({ messages: msgs });
    expect(result.detected).toBe(true);
    expect(result.reason).toContain('todo plan');
  });

  it('detects repeated reasoning', () => {
    const text = 'I will refactor the authentication module to use JWT tokens instead of sessions';
    const msgs = Array.from({ length: 4 }, () => makeMsg([reasoningPart(text)]));
    const result = detectSemanticLoop({ messages: msgs });
    expect(result.detected).toBe(true);
  });

  it('ignores user messages', () => {
    const userMsg = makeMsg([], 'user');
    const result = detectSemanticLoop({ messages: [userMsg] });
    expect(result.detected).toBe(false);
  });

  it('respects custom windowSize', () => {
    const msgs = Array.from({ length: 8 }, () => makeMsg([patchPart(['a.ts'])]));
    const withSmallWindow = detectSemanticLoop({ messages: msgs, windowSize: 8 });
    expect(withSmallWindow.detected).toBe(true);
  });

  it('does not false-positive on diverse edits', () => {
    const msgs = [0, 1, 2, 3].map((i) => makeMsg([patchPart([`file-${i}.ts`])]));
    const result = detectSemanticLoop({ messages: msgs });
    expect(result.detected).toBe(false);
  });
});