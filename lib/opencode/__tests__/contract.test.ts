//
// Contract tests — opencode response schema snapshots.
//
// Validates that opencode's API response shapes haven't changed by testing
// the `hasFields` validators against known-good sample payloads. If opencode
// renames or drops a critical field, these tests catch it at build time
// instead of silently breaking at runtime (the #1 source of postmortems).
//
// Note: `hasFields` checks property PRESENCE (via `in` operator), not value
// validity. Setting a field to `undefined` keeps the key — the validator
// passes. This matches the validator's design: we check shape, not nullability.
// To test actual field removal, use `delete` or `const { field, ...rest }`.
//
// See docs/opencode-quirks.md for the field semantics driving each validator.

import { describe, it, expect } from 'vitest';
import {
  isOpencodeSession,
  isOpencodeSessionArray,
  isOpencodeMessage,
  isOpencodeMessageArray,
  isOpencodeMessageInfo,
  isOpencodeProject,
  isOpencodeProjectArray,
  isOpencodeDiffEntry,
  isOpencodeDiffArray,
} from '../validators';

// ─── Known-good sample payloads ──────────────────────────────────────

const SAMPLE_SESSION = {
  id: 'ses_abc123',
  slug: 'abc123',
  projectID: 'proj_001',
  directory: 'C:\\Users\\kevin\\Workspace\\foo',
  title: 'My Session',
  version: '1.0.0',
  time: { created: 1700000000000, updated: 1700000001000 },
};

const SAMPLE_MESSAGE_INFO = {
  id: 'msg_abc123',
  sessionID: 'ses_abc123',
  role: 'assistant' as const,
  tokens: { input: 1000, output: 500, total: 1500, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1700000000000, completed: 1700000005000 },
};

const SAMPLE_MESSAGE = {
  info: SAMPLE_MESSAGE_INFO,
  parts: [
    {
      id: 'prt_001',
      sessionID: 'ses_abc123',
      messageID: 'msg_abc123',
      type: 'text' as const,
      text: 'Here is the fix.',
    },
  ],
};

const SAMPLE_PROJECT = {
  id: 'proj_001',
  worktree: 'C:\\Users\\kevin\\Workspace\\foo',
  time: { created: 1700000000000, updated: 1700000001000 },
  sandboxes: [],
};

const SAMPLE_DIFF_ENTRY = {
  file: 'src/auth.ts',
  patch: '@@ -1,5 +1,6 @@',
};

// ─── Contract tests ──────────────────────────────────────────────────

describe('Opencode contract: session', () => {
  it('accepts a valid session payload', () => {
    expect(isOpencodeSession(SAMPLE_SESSION)).toBe(true);
  });

  it('accepts a valid session array', () => {
    expect(isOpencodeSessionArray([SAMPLE_SESSION, SAMPLE_SESSION])).toBe(true);
  });

  it('rejects a session with id field removed (rename/drop)', () => {
    const { id, ...broken } = SAMPLE_SESSION;
    expect(isOpencodeSession(broken)).toBe(false);
  });

  it('rejects a session with time field removed', () => {
    const { time, ...broken } = SAMPLE_SESSION;
    expect(isOpencodeSession(broken)).toBe(false);
  });
});

describe('Opencode contract: message', () => {
  it('accepts a valid message payload', () => {
    expect(isOpencodeMessage(SAMPLE_MESSAGE)).toBe(true);
  });

  it('accepts a valid message array', () => {
    expect(isOpencodeMessageArray([SAMPLE_MESSAGE, SAMPLE_MESSAGE])).toBe(true);
  });

  it('rejects a message with info field removed', () => {
    const { info, ...broken } = SAMPLE_MESSAGE;
    expect(isOpencodeMessage(broken)).toBe(false);
  });

  it('rejects a message with parts field removed', () => {
    const { parts, ...broken } = SAMPLE_MESSAGE;
    expect(isOpencodeMessage(broken)).toBe(false);
  });

  it('accepts a valid message info payload', () => {
    expect(isOpencodeMessageInfo(SAMPLE_MESSAGE_INFO)).toBe(true);
  });

  it('rejects message info with id removed', () => {
    const { id, ...broken } = SAMPLE_MESSAGE_INFO;
    expect(isOpencodeMessageInfo(broken)).toBe(false);
  });

  it('rejects message info with role removed', () => {
    const { role, ...broken } = SAMPLE_MESSAGE_INFO;
    expect(isOpencodeMessageInfo(broken)).toBe(false);
  });
});

describe('Opencode contract: project', () => {
  it('accepts a valid project payload', () => {
    expect(isOpencodeProject(SAMPLE_PROJECT)).toBe(true);
  });

  it('rejects a project with worktree removed', () => {
    const { worktree, ...broken } = SAMPLE_PROJECT;
    expect(isOpencodeProject(broken)).toBe(false);
  });
});

describe('Opencode contract: diff', () => {
  it('accepts a valid diff entry', () => {
    expect(isOpencodeDiffEntry(SAMPLE_DIFF_ENTRY)).toBe(true);
  });

  it('accepts a valid diff array', () => {
    expect(isOpencodeDiffArray([SAMPLE_DIFF_ENTRY])).toBe(true);
  });

  it('rejects a diff entry with file removed', () => {
    const { file, ...broken } = SAMPLE_DIFF_ENTRY;
    expect(isOpencodeDiffEntry(broken)).toBe(false);
  });

  it('rejects a diff entry with patch removed', () => {
    const { patch, ...broken } = SAMPLE_DIFF_ENTRY;
    expect(isOpencodeDiffEntry(broken)).toBe(false);
  });
});

describe('Opencode contract: real-world shapes', () => {
  it('accepts a session with optional summary field', () => {
    const withSummary = { ...SAMPLE_SESSION, summary: { additions: 10, deletions: 3, files: 2 } };
    expect(isOpencodeSession(withSummary)).toBe(true);
  });

  it('accepts a message with empty parts array', () => {
    const noParts = { ...SAMPLE_MESSAGE, parts: [] };
    expect(isOpencodeMessage(noParts)).toBe(true);
  });

  it('accepts a session missing slug (optional field)', () => {
    const { slug, ...rest } = SAMPLE_SESSION;
    expect(isOpencodeSession(rest)).toBe(true);
  });
});
