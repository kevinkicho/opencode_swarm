// OpencodeMessage builders for tests.
//
// Centralized in _helpers/ as part of #111. Two builders cover the
// common shapes:
//   - makeAssistant(): a streaming-or-completed assistant turn
//   - makeUser(): a user prompt
//
// Both accept loose partial overrides; the defaults are minimal but
// type-safe via `as unknown as OpencodeMessage` (the SDK's actual
// type has a deep info / parts shape that's painful to construct
// fully — tests only need the slices they assert against).

import type { OpencodeMessage } from '../../../opencode/types';

export interface MakeAssistantOpts {
  id?: string;
  // null (default) = in-progress, number = completed timestamp.
  completed?: number | null;
  // How many text parts to attach. Defaults to 1 — enough for "the
  // turn produced something." Pass 0 for "message exists but no parts
  // yet" (the F1 silent-watchdog edge case).
  parts?: number;
  // opencode error object — `{ name, message }` or any shape. Setting
  // this implies the turn errored regardless of `completed`.
  error?: unknown;
  // Most callers don't care; defaults to 0 so the message looks
  // freshly-created from the test's POV.
  created?: number;
}

export function makeAssistant(opts: MakeAssistantOpts = {}): OpencodeMessage {
  const id = opts.id ?? 'm1';
  return {
    info: {
      id,
      role: 'assistant',
      time: {
        created: opts.created ?? Date.now(),
        completed: opts.completed ?? null,
      },
      ...(opts.error ? { error: opts.error } : {}),
    },
    parts: Array(opts.parts ?? 1).fill({ type: 'text', text: 'streaming…' }),
  } as unknown as OpencodeMessage;
}

export interface MakeUserOpts {
  id?: string;
  text?: string;
  created?: number;
}

export function makeUser(opts: MakeUserOpts = {}): OpencodeMessage {
  return {
    info: {
      id: opts.id ?? 'u1',
      role: 'user',
      time: {
        created: opts.created ?? 0,
        completed: opts.created ?? 0,
      },
    },
    parts: [
      { type: 'text', text: opts.text ?? 'do the thing' },
    ],
  } as unknown as OpencodeMessage;
}
