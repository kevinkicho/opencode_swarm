// Semantic loop detector — catches agents that repeat semantically
// similar actions even when the structural tool-loop detector in wait.ts
// doesn't fire (different error messages, different args, same intent).
//
// The detector examines the last N assistant messages in a session and
// checks for:
//   1. Repeated edits to the same file (same filePath, different content)
//   2. Repeated todowrite plans with high content overlap
//   3. Repeated reasoning phrases (same decision markers)
//
// Detection is per-tick; the coordinator calls `detectSemanticLoop` after
// each tick cycle. The signal is advisory — the coordinator decides
// whether to mark the item stale or abort the turn.

import 'server-only';

import type { OpencodeMessage, OpencodePart } from '@/lib/opencode/types';

export interface SemanticLoopInput {
  messages: OpencodeMessage[];
  // How many recent assistant messages to examine. Default 6.
  windowSize?: number;
}

export interface SemanticLoopResult {
  detected: boolean;
  reason?: string;
  // Which file paths or content hashes repeated
  evidence?: string[];
}

// A single action extracted from a message's parts.
interface ExtractedAction {
  kind: 'edit' | 'todowrite' | 'reasoning';
  // For edits: the file path. For todowrite: a content hash.
  // For reasoning: the first 80 chars trimmed.
  key: string;
}

const DEFAULT_WINDOW = 6;
const REPEAT_THRESHOLD = 3;

function extractActions(parts: OpencodePart[]): ExtractedAction[] {
  const actions: ExtractedAction[] = [];
  for (const p of parts) {
    if (p.type === 'patch' && Array.isArray(p.files)) {
      for (const f of p.files) {
        if (typeof f === 'string') {
          actions.push({ kind: 'edit', key: f });
        }
      }
    }
    if (p.type === 'tool') {
      const tool = (p as { tool?: string }).tool;
      if (tool === 'todowrite') {
        const state = (p as { state?: { input?: { todos?: unknown } } }).state;
        if (state && typeof state === 'object') {
          const input = (state as { input?: { todos?: unknown } }).input;
          if (input && typeof input === 'object') {
            const todos = (input as { todos?: unknown[] }).todos;
            if (Array.isArray(todos)) {
              for (const t of todos) {
                if (t && typeof t === 'object' && typeof (t as { content?: string }).content === 'string') {
                  const c = (t as { content: string }).content;
                  actions.push({ kind: 'todowrite', key: simpleHash(c) });
                }
              }
            }
          }
        }
      }
    }
    if (p.type === 'reasoning') {
      const text = (p as { text?: string }).text;
      if (typeof text === 'string' && text.length > 10) {
        actions.push({ kind: 'reasoning', key: text.slice(0, 80) });
      }
    }
  }
  return actions;
}

// Fast, non-cryptographic hash for content dedup. Not security-sensitive.
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function detectSemanticLoop(input: SemanticLoopInput): SemanticLoopResult {
  const { messages, windowSize = DEFAULT_WINDOW } = input;
  const assistants = messages.filter((m) => m.info.role === 'assistant');
  const window = assistants.slice(-windowSize);
  if (window.length < REPEAT_THRESHOLD) return { detected: false };

  const editCounts = new Map<string, number>();
  const todoCounts = new Map<string, number>();
  const reasoningCounts = new Map<string, number>();

  for (const msg of window) {
    for (const action of extractActions(msg.parts)) {
      switch (action.kind) {
        case 'edit': {
          editCounts.set(action.key, (editCounts.get(action.key) ?? 0) + 1);
          break;
        }
        case 'todowrite': {
          todoCounts.set(action.key, (todoCounts.get(action.key) ?? 0) + 1);
          break;
        }
        case 'reasoning': {
          reasoningCounts.set(action.key, (reasoningCounts.get(action.key) ?? 0) + 1);
          break;
        }
      }
    }
  }

  const evidence: string[] = [];

  for (const [path, count] of editCounts) {
    if (count >= REPEAT_THRESHOLD) {
      return {
        detected: true,
        reason: `Edited ${path} ${count}× in last ${window.length} messages — possible edit loop`,
        evidence: [path],
      };
    }
  }

  for (const [hash, count] of todoCounts) {
    if (count >= REPEAT_THRESHOLD) {
      evidence.push(`todo:${hash}`);
    }
  }
  if (evidence.length > 0) {
    return {
      detected: true,
      reason: `Repeated ${evidence.length} todo plan(s) in last ${window.length} messages — possible planning loop`,
      evidence,
    };
  }

  for (const [snippet, count] of reasoningCounts) {
    if (count >= REPEAT_THRESHOLD) {
      return {
        detected: true,
        reason: `Repeated reasoning "${snippet.slice(0, 40)}…" ${count}× — possible deliberation loop`,
        evidence: [snippet],
      };
    }
  }

  return { detected: false };
}