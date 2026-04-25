// Silent-session detector — surfaces in the UI's run-health chip.
// STATUS.md "Run-health surfacing #4: No 'assistant silent since
// dispatch' signal anywhere."
//
// A session whose only message is a user prompt with no assistant
// response is indistinguishable from a healthy one pre-generation.
// The F1 dispatch watchdog catches this server-side at 240s (abort);
// this derives the same condition client-side so the user sees the
// silence BEFORE the watchdog gives up — actionable warning, not
// post-mortem.
//
// Pure function over the slot/messages snapshot. Cheap (single pass
// per session) and stateless — derive fresh on every render.

import type { OpencodeMessage } from './opencode/types';

export interface SilentSession {
  sessionID: string;
  // Wall-clock ms of the last user prompt (the dispatch).
  silentSinceMs: number;
  // Age of the silence (now − silentSinceMs).
  silentMs: number;
}

// Default threshold matches the F1 watchdog's WARN level — by the
// time we surface the chip, the server has also logged its first
// concern. Operators picking either signal up arrive at the same
// conclusion. Tunable via the `thresholdMs` argument for tests.
export const SILENT_SESSION_THRESHOLD_MS = 90_000;

export function deriveSilentSessions(
  slots: Array<{ sessionID: string; messages: OpencodeMessage[] }>,
  nowMs: number = Date.now(),
  thresholdMs: number = SILENT_SESSION_THRESHOLD_MS,
): SilentSession[] {
  const out: SilentSession[] = [];
  for (const slot of slots) {
    if (slot.messages.length === 0) continue;
    // Walk backwards to the most recent user message — that's the
    // dispatch we're checking against.
    let lastUserMs: number | null = null;
    let lastUserIndex = -1;
    for (let i = slot.messages.length - 1; i >= 0; i -= 1) {
      const m = slot.messages[i];
      if (m.info.role === 'user') {
        lastUserMs = m.info.time.created ?? null;
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserMs === null) continue;
    // If any assistant message exists after the last user prompt,
    // the session has at least started responding — not silent.
    // We don't require completion (a streaming assistant is still
    // "doing something"); F1 watchdog covers the no-progress case.
    let hasAssistantAfter = false;
    for (let i = lastUserIndex + 1; i < slot.messages.length; i += 1) {
      if (slot.messages[i].info.role === 'assistant') {
        hasAssistantAfter = true;
        break;
      }
    }
    if (hasAssistantAfter) continue;
    const silentMs = nowMs - lastUserMs;
    if (silentMs >= thresholdMs) {
      out.push({
        sessionID: slot.sessionID,
        silentSinceMs: lastUserMs,
        silentMs,
      });
    }
  }
  return out;
}
