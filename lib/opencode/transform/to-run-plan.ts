//
// todowrite → TodoItem[] projection. Each todowrite call fully replaces
// the prior list, so only the LAST invocation matters. Where possible,
// plan items are bound back to the `task` tool call that delegated their
// work (DESIGN.md §8.3 option (b) — prompt-content match) so the inspector
// can navigate "this todo · who took it on?".

import type { TodoItem, TodoStatus } from '../../swarm-types';
import type { OpencodeMessage } from '../types';
import { agentIdFor } from './_shared';

// opencode's todowrite payload lives at part.state.input.todos — each call
// fully replaces the prior list, so only the LAST invocation matters.
interface RawTodo {
  content: string;
  status?: string;
  priority?: string;
}

function rawTodosFromState(state: unknown): RawTodo[] | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as { input?: unknown };
  if (!s.input || typeof s.input !== 'object') return null;
  const inp = s.input as { todos?: unknown };
  if (!Array.isArray(inp.todos)) return null;
  return inp.todos.filter(
    (t): t is RawTodo =>
      !!t && typeof t === 'object' && typeof (t as RawTodo).content === 'string',
  );
}

function mapTodoStatus(s: string | undefined): TodoStatus {
  switch (s) {
    case 'completed': return 'completed';
    case 'in_progress': return 'in_progress';
    case 'failed': return 'failed';
    case 'cancelled':
    case 'abandoned': return 'abandoned';
    default: return 'pending';
  }
}

// Harvest every `task` tool call with its messageID, the description/prompt
// string, and the subagent name the caller asked for. Used to bind plan items
// back to their delegation site (DESIGN.md §8.3 option (b) — prompt-content
// match; option (a) would inject an ID into the task description but requires
// a backend tool wrapper we don't have yet).
interface TaskCall {
  messageId: string;
  // sessionID of the delegating assistant message. Used to disambiguate
  // ownerAgentId across council members — a task call from member A's
  // session binds its subagent to member A's roster row, not to a shared
  // ag_<subagentName> that would collapse every council member's delegations.
  sessionID: string;
  subagentName?: string;  // from input.subagent_type (opencode convention)
  text: string;           // description + prompt, lowercased, for token matching
}

function taskCallsFrom(messages: OpencodeMessage[]): TaskCall[] {
  const calls: TaskCall[] = [];
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    for (const part of m.parts) {
      if (part.type !== 'tool' || part.tool !== 'task') continue;
      const inp = part.input;
      if (!inp || typeof inp !== 'object') continue;
      const io = inp as {
        description?: unknown;
        prompt?: unknown;
        subagent_type?: unknown;
      };
      const description = typeof io.description === 'string' ? io.description : '';
      const prompt = typeof io.prompt === 'string' ? io.prompt : '';
      const subagent = typeof io.subagent_type === 'string' ? io.subagent_type : undefined;
      calls.push({
        messageId: m.info.id,
        sessionID: m.info.sessionID,
        subagentName: subagent,
        text: `${description}\n${prompt}`.toLowerCase(),
      });
    }
  }
  return calls;
}

// Content tokens for similarity scoring. Drop stopwords — they produce
// spurious high-overlap scores between unrelated todos.
const TODO_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could',
  'this', 'that', 'these', 'those', 'it', 'its', 'then', 'than', 'so',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !TODO_STOPWORDS.has(w)),
  );
}

// Containment score: what fraction of the todo's distinctive tokens appear in
// the task call's text. Asymmetric on purpose — the task prompt is usually
// longer than the todo, so symmetric Jaccard under-scores real matches.
function containment(todoTokens: Set<string>, callText: string): number {
  if (todoTokens.size === 0) return 0;
  const callTokens = tokenize(callText);
  let hit = 0;
  for (const t of todoTokens) if (callTokens.has(t)) hit += 1;
  return hit / todoTokens.size;
}

const TODO_MATCH_THRESHOLD = 0.5;

export function toRunPlan(messages: OpencodeMessage[]): TodoItem[] {
  let latest: { todos: RawTodo[]; messageId: string; callIndex: number } | null = null;
  let callIndex = 0;

  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type !== 'tool' || part.tool !== 'todowrite') continue;
      callIndex += 1;
      const todos = rawTodosFromState(part.state);
      if (todos) latest = { todos, messageId: m.info.id, callIndex };
    }
  }

  if (!latest) return [];

  const taskCalls = taskCallsFrom(messages);
  const claimed = new Set<number>();

  // Longer/more-specific todos first so a short todo can't steal a task call
  // that genuinely fits a longer one. Preserve original order in the output.
  const ordered = latest.todos
    .map((t, i) => ({ t, i, tokens: tokenize(t.content) }))
    .sort((a, b) => b.tokens.size - a.tokens.size);

  const boundByIndex = new Map<number, { taskMessageId: string; ownerAgentId?: string }>();

  for (const { t, i, tokens } of ordered) {
    if (tokens.size === 0) continue;
    let bestIdx = -1;
    let bestScore = TODO_MATCH_THRESHOLD;
    for (let j = 0; j < taskCalls.length; j += 1) {
      if (claimed.has(j)) continue;
      const score = containment(tokens, taskCalls[j].text);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }
    if (bestIdx >= 0) {
      claimed.add(bestIdx);
      const call = taskCalls[bestIdx];
      boundByIndex.set(i, {
        taskMessageId: call.messageId,
        ownerAgentId: call.subagentName
          ? agentIdFor(call.subagentName, 'assistant', call.sessionID)
          : undefined,
      });
    }
    // silence unused-var warning — `t` is part of the destructure key set
    void t;
  }

  return latest.todos.map((t, i) => {
    const bound = boundByIndex.get(i);
    return {
      id: `tdo_${latest!.callIndex}_${i}`,
      content: t.content,
      status: mapTodoStatus(t.status),
      taskMessageId: bound?.taskMessageId,
      ownerAgentId: bound?.ownerAgentId,
    };
  });
}
