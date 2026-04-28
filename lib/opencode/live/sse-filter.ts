// Pure parsing + filtering for SSE events from opencode's /event stream.
// Extracted from useLiveSwarmRunMessages so the routing logic is unit-
// testable without spinning up React, EventSource, and a TanStack Query
// provider. The hook still owns the state-update side effects; this
// helper just answers "should I handle this raw frame, and what does it
// claim?".
//
// Why extract: the hook fans one EventSource across N sessions per run,
// and a silent regression in this filter (e.g., dropping a session by
// mistake, or letting a malformed frame through) shows up as "frozen
// runs" in the UI without any visible error. Locking the filter behind
// a unit test is the cheapest insurance.

import type { OpencodeMessage, OpencodePart } from '../types';

export type SseEventDecision =
  | { kind: 'ignore'; reason: 'parse-error' | 'no-session' | 'unknown-session' | 'no-type' }
  | { kind: 'part'; sessionID: string; messageID: string; part: OpencodePart }
  | { kind: 'info'; sessionID: string; info: OpencodeMessage['info'] }
  | { kind: 'refetch'; sessionID: string; type: string };

interface RawFrame {
  type?: unknown;
  properties?: {
    sessionID?: unknown;
    messageID?: unknown;
    part?: unknown;
    info?: unknown;
  };
}

// Decide what to do with a raw SSE frame. Caller mocks `validatePart`
// in or out of the result depending on whether they want strict or
// permissive part validation. We default to passing the part through
// untyped here so the helper stays pure (no I/O, no schema check).
//
// Decisions:
//   - parse-error / heartbeat-empty: ignore
//   - no sessionID or unknown sessionID: ignore (filter to our run)
//   - 'message.part.updated' with messageID + part: 'part' decision
//   - 'message.updated' with info: 'info' decision
//   - any other typed event for a known session: 'refetch'
export function classifySseFrame(
  rawData: string,
  knownSessions: ReadonlySet<string>,
): SseEventDecision {
  let parsed: RawFrame;
  try {
    parsed = JSON.parse(rawData) as RawFrame;
  } catch {
    return { kind: 'ignore', reason: 'parse-error' };
  }
  const props = parsed.properties ?? {};
  const sid = typeof props.sessionID === 'string' ? props.sessionID : null;
  if (!sid) return { kind: 'ignore', reason: 'no-session' };
  if (!knownSessions.has(sid)) return { kind: 'ignore', reason: 'unknown-session' };
  const type = typeof parsed.type === 'string' ? parsed.type : null;
  if (!type) return { kind: 'ignore', reason: 'no-type' };

  if (type === 'message.part.updated') {
    const messageID = typeof props.messageID === 'string' ? props.messageID : null;
    if (!messageID || !props.part) {
      // malformed — fall through to refetch so the slot can recover from
      // the canonical /message endpoint
      return { kind: 'refetch', sessionID: sid, type };
    }
    return {
      kind: 'part',
      sessionID: sid,
      messageID,
      part: props.part as OpencodePart,
    };
  }

  if (type === 'message.updated') {
    if (!props.info) {
      return { kind: 'refetch', sessionID: sid, type };
    }
    return {
      kind: 'info',
      sessionID: sid,
      info: props.info as OpencodeMessage['info'],
    };
  }

  // Any other typed event scoped to a known session triggers a refetch.
  // permission.updated / permission.replied / message.removed / file.edited /
  // todo.updated / command.executed / session.* (lifecycle) all land here.
  // Refetch is the safe default — local merge logic only covers part + info
  // updates. Server-level events that lack `sessionID` (server.connected,
  // server.instance.disposed, file.watcher.updated, vcs.branch.updated) are
  // intentionally dropped by the no-session filter above; they don't change
  // per-run state.
  return { kind: 'refetch', sessionID: sid, type };
}
