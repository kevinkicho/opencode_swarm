import { describe, expect, it } from 'vitest';
import {
  deriveSilentSessions,
  SILENT_SESSION_THRESHOLD_MS,
} from '../silent-session';
import type { OpencodeMessage } from '../opencode/types';

// Silent-session detection drives the run-health chip. False positives
// nag the operator about healthy sessions; false negatives hide real
// stuck sessions until F1 watchdog declares opencode-frozen 240s in.
// The function's contract is "session has unanswered user prompt for
// ≥ thresholdMs."

const NOW = 1_700_000_000_000;
const userMsg = (id: string, createdAtMs: number): OpencodeMessage => ({
  info: {
    id,
    role: 'user',
    sessionID: 's1',
    time: { created: createdAtMs },
  },
  parts: [],
} as unknown as OpencodeMessage);
const asstMsg = (id: string, createdAtMs: number, completed?: number): OpencodeMessage => ({
  info: {
    id,
    role: 'assistant',
    sessionID: 's1',
    time: { created: createdAtMs, completed },
  },
  parts: [],
} as unknown as OpencodeMessage);

describe('deriveSilentSessions', () => {
  it('returns empty for empty slots', () => {
    expect(deriveSilentSessions([])).toEqual([]);
  });

  it('skips sessions with no user message', () => {
    const out = deriveSilentSessions(
      [{ sessionID: 's1', messages: [asstMsg('a1', NOW - 200_000)] }],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('skips sessions where assistant responded after user', () => {
    const out = deriveSilentSessions(
      [
        {
          sessionID: 's1',
          messages: [
            userMsg('u1', NOW - 200_000),
            asstMsg('a1', NOW - 195_000),
          ],
        },
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('flags a session with unanswered user prompt past threshold', () => {
    const out = deriveSilentSessions(
      [
        {
          sessionID: 's1',
          messages: [userMsg('u1', NOW - 200_000)],
        },
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sessionID).toBe('s1');
    expect(out[0].silentMs).toBe(200_000);
  });

  it('does NOT flag silence below threshold', () => {
    const out = deriveSilentSessions(
      [{ sessionID: 's1', messages: [userMsg('u1', NOW - 30_000)] }],
      NOW,
      90_000,
    );
    expect(out).toEqual([]);
  });

  it('uses the most recent user message as the dispatch anchor', () => {
    // Two dispatches: first answered, second pending.
    const out = deriveSilentSessions(
      [
        {
          sessionID: 's1',
          messages: [
            userMsg('u1', NOW - 500_000),
            asstMsg('a1', NOW - 495_000), // first answered
            userMsg('u2', NOW - 200_000), // second pending
          ],
        },
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].silentMs).toBe(200_000); // measured from u2, not u1
  });

  it('threshold defaults to SILENT_SESSION_THRESHOLD_MS', () => {
    // 89s ago = below default 90s threshold; not flagged
    const out89 = deriveSilentSessions(
      [{ sessionID: 's1', messages: [userMsg('u1', NOW - 89_000)] }],
      NOW,
    );
    expect(out89).toEqual([]);
    // 91s ago = above threshold; flagged
    const out91 = deriveSilentSessions(
      [{ sessionID: 's1', messages: [userMsg('u1', NOW - 91_000)] }],
      NOW,
    );
    expect(out91).toHaveLength(1);
    expect(SILENT_SESSION_THRESHOLD_MS).toBe(90_000);
  });

  it('handles multiple sessions independently', () => {
    const out = deriveSilentSessions(
      [
        {
          sessionID: 's1',
          messages: [userMsg('u1', NOW - 200_000)],
        },
        {
          sessionID: 's2',
          messages: [
            userMsg('u1', NOW - 200_000),
            asstMsg('a1', NOW - 195_000),
          ],
        },
        {
          sessionID: 's3',
          messages: [userMsg('u1', NOW - 30_000)],
        },
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sessionID).toBe('s1');
  });

  it('streaming assistant (no completed) is NOT silent — already started', () => {
    // Even though completed is missing, the assistant message exists
    // → session has started responding. Not silent. F1 watchdog
    // covers the in-flight-but-not-progressing case separately.
    const out = deriveSilentSessions(
      [
        {
          sessionID: 's1',
          messages: [
            userMsg('u1', NOW - 200_000),
            asstMsg('a1', NOW - 100_000, undefined), // streaming
          ],
        },
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });
});
