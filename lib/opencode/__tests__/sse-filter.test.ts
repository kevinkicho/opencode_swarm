// Tests for the SSE event classifier — the routing logic the live-runs
// hook uses to decide whether a frame from opencode's /event stream
// triggers a local merge or a full refetch.

import { describe, it, expect } from 'vitest';

import { classifySseFrame } from '../live/sse-filter';

const SESSIONS = new Set(['ses_alpha', 'ses_beta']);

describe('classifySseFrame', () => {
  it('ignores malformed JSON (heartbeat / connect frames)', () => {
    const out = classifySseFrame('not json{', SESSIONS);
    expect(out.kind).toBe('ignore');
    if (out.kind === 'ignore') expect(out.reason).toBe('parse-error');
  });

  it('ignores frames with no sessionID', () => {
    const out = classifySseFrame(JSON.stringify({ type: 'foo' }), SESSIONS);
    expect(out.kind).toBe('ignore');
    if (out.kind === 'ignore') expect(out.reason).toBe('no-session');
  });

  it('ignores frames for sessions not in our run', () => {
    const out = classifySseFrame(
      JSON.stringify({
        type: 'message.updated',
        properties: { sessionID: 'ses_someone_else', info: { id: 'm1' } },
      }),
      SESSIONS,
    );
    expect(out.kind).toBe('ignore');
    if (out.kind === 'ignore') expect(out.reason).toBe('unknown-session');
  });

  it('routes message.part.updated to a part decision when complete', () => {
    const part = { id: 'p1', type: 'text', text: 'hi' };
    const out = classifySseFrame(
      JSON.stringify({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_alpha',
          messageID: 'm1',
          part,
        },
      }),
      SESSIONS,
    );
    expect(out.kind).toBe('part');
    if (out.kind === 'part') {
      expect(out.sessionID).toBe('ses_alpha');
      expect(out.messageID).toBe('m1');
      expect(out.part).toEqual(part);
    }
  });

  it('falls back to refetch when message.part.updated lacks messageID', () => {
    const out = classifySseFrame(
      JSON.stringify({
        type: 'message.part.updated',
        properties: { sessionID: 'ses_alpha', part: { id: 'p1', type: 'text' } },
      }),
      SESSIONS,
    );
    expect(out.kind).toBe('refetch');
  });

  it('routes message.updated to an info decision when info is present', () => {
    const info = { id: 'm1', role: 'assistant' as const, time: { created: 1, completed: 2 } };
    const out = classifySseFrame(
      JSON.stringify({
        type: 'message.updated',
        properties: { sessionID: 'ses_beta', info },
      }),
      SESSIONS,
    );
    expect(out.kind).toBe('info');
    if (out.kind === 'info') {
      expect(out.sessionID).toBe('ses_beta');
      expect(out.info).toEqual(info);
    }
  });

  it('routes other event types to refetch with the type captured', () => {
    const out = classifySseFrame(
      JSON.stringify({
        type: 'todo.updated',
        properties: { sessionID: 'ses_alpha' },
      }),
      SESSIONS,
    );
    expect(out.kind).toBe('refetch');
    if (out.kind === 'refetch') {
      expect(out.type).toBe('todo.updated');
      expect(out.sessionID).toBe('ses_alpha');
    }
  });

  it('handles empty knownSessions set without throwing', () => {
    const out = classifySseFrame(
      JSON.stringify({
        type: 'message.updated',
        properties: { sessionID: 'ses_alpha' },
      }),
      new Set(),
    );
    expect(out.kind).toBe('ignore');
    if (out.kind === 'ignore') expect(out.reason).toBe('unknown-session');
  });

  it('ignores frames where type is missing but session matches', () => {
    const out = classifySseFrame(
      JSON.stringify({ properties: { sessionID: 'ses_alpha' } }),
      SESSIONS,
    );
    expect(out.kind).toBe('ignore');
    if (out.kind === 'ignore') expect(out.reason).toBe('no-type');
  });
});
