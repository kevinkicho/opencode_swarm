// Maps live opencode session data into the prototype's mock-data shapes
// (Agent[] / AgentMessage[] / RunMeta / ProviderSummary[]) so the existing
// timeline, roster, and inspector can render it with zero component changes.

import type {
  Agent,
  AgentMessage,
  RunMeta,
  ProviderSummary,
  Provider,
  PartType,
  ToolName,
  ToolState,
  TodoItem,
  TodoStatus,
} from '../swarm-types';
import type { DiffData, DiffHunk, DiffLine } from '../types';
import type {
  OpencodeMessage,
  OpencodePart,
  OpencodeSession,
  OpencodeTokenUsage,
} from './types';
import { priceFor } from './pricing';

const ACCENT_ROTATION: Agent['accent'][] = ['molten', 'mint', 'iris', 'amber', 'fog'];
const KNOWN_TOOLS: ToolName[] = [
  'bash', 'read', 'write', 'edit', 'list', 'grep', 'glob',
  'webfetch', 'todowrite', 'todoread', 'task',
];
const KNOWN_PARTS: PartType[] = [
  'text', 'reasoning', 'tool', 'file', 'agent', 'subtask',
  'step-start', 'step-finish', 'snapshot', 'patch', 'retry', 'compaction',
];

// Opencode's providerID is per-message and reflects the routing gateway, not
// the model vendor. Per CLAUDE.md the UI's provider universe is `zen` + `go`
// only — BYOK-shaped providerIDs (anthropic, openai, gemini, …) still route
// through opencode here and are bucketed as `zen`. `go` requires a positive
// bundle/subscription signal because zen vs go is often an account-level
// distinction opencode doesn't echo per-message.
function providerOf(providerID?: string): Provider {
  if (!providerID) return 'zen';
  const p = providerID.toLowerCase();
  if (p.includes('-go') || p.includes('bundle') || p.includes('subscription')) return 'go';
  return 'zen';
}

// Cost fallback for messages where opencode didn't populate `info.cost` (free
// tiers, old sessions, go-bundle messages). Computes per-1M pricing × tokens
// from the zen table. Returns 0 when the model isn't in the table or tokens
// are missing — better than NaN, and aligns with zero-cost free tiers.
function derivedCost(info: OpencodeMessage['info']): number {
  if (typeof info.cost === 'number') return info.cost;
  const price = priceFor(info.modelID);
  const t = info.tokens;
  if (!price || !t) return 0;
  const input = t.input * price.input;
  const output = t.output * price.output;
  const cachedRead = t.cache.read * price.cached;
  const cachedWrite = t.cache.write * (price.write ?? price.input);
  return (input + output + cachedRead + cachedWrite) / 1_000_000;
}

function familyOf(modelID?: string): Agent['model']['family'] {
  const m = (modelID ?? '').toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt')) return 'gpt';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('glm')) return 'glm';
  return 'claude';
}

function normalizeTool(name: string | undefined): ToolName | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return KNOWN_TOOLS.find((t) => t === n);
}

function normalizePart(t: string): PartType {
  return (KNOWN_PARTS.find((p) => p === t) ?? 'text');
}

function toolStateFrom(state: unknown): ToolState {
  if (state && typeof state === 'object' && 'status' in state) {
    const s = (state as { status: unknown }).status;
    if (s === 'completed' || s === 'running' || s === 'pending' || s === 'error') return s;
  }
  return 'completed';
}

// opencode's abort path sets tool state to { status: "error", metadata: { interrupted: true } }.
// Distinguish these from natural errors so the timeline can render them as abandoned, not failed.
function isInterruptedTool(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const meta = (state as { metadata?: unknown }).metadata;
  if (!meta || typeof meta !== 'object') return false;
  return (meta as { interrupted?: unknown }).interrupted === true;
}

function fmtTs(ms: number, anchor: number): string {
  const delta = Math.max(0, Math.floor((ms - anchor) / 1000));
  const m = Math.floor(delta / 60);
  const s = delta % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(startMs?: number, endMs?: number): string | undefined {
  if (!startMs || !endMs) return undefined;
  const ms = endMs - startMs;
  if (ms <= 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem}s`;
}

function synthesizeTitle(part: OpencodePart): string {
  switch (part.type) {
    case 'text': return firstLine(part.text) || 'text';
    case 'reasoning': return firstLine(part.text) || 'reasoning';
    case 'tool': return part.tool ?? 'tool';
    case 'step-start': return 'step start';
    case 'step-finish': return `step finish · ${part.reason}`;
    case 'patch': {
      const n = part.files.length;
      return n === 1
        ? `patch · ${part.files[0]}`
        : `patch · ${n} files`;
    }
    default: return 'event';
  }
}

function firstLine(s: string | undefined, max = 80): string {
  if (!s) return '';
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function bodyOf(part: OpencodePart): string | undefined {
  if (part.type === 'text' || part.type === 'reasoning') return part.text;
  if (part.type === 'tool') {
    const inp = part.input;
    if (typeof inp === 'string') return inp;
    if (inp && typeof inp === 'object') return JSON.stringify(inp, null, 2);
    return undefined;
  }
  return undefined;
}

function previewOf(part: OpencodePart): string | undefined {
  if (part.type !== 'tool') return undefined;
  const out = part.output;
  if (typeof out === 'string') return firstLine(out, 160);
  return undefined;
}

function isHumanAgentId(id: string | undefined): boolean {
  return !id || id === 'user' || id === 'human';
}

function agentIdFor(agentName: string | undefined, role: 'user' | 'assistant'): string {
  if (role === 'user') return 'human';
  return `ag_${(agentName ?? 'assistant').replace(/[^a-z0-9_-]/gi, '')}`;
}

export function toAgents(messages: OpencodeMessage[]): {
  agents: Agent[];
  agentOrder: string[];
} {
  const byId = new Map<string, Agent>();
  const order: string[] = [];

  messages.forEach((m, idx) => {
    if (m.info.role !== 'assistant') return;
    const id = agentIdFor(m.info.agent, 'assistant');
    const existing = byId.get(id);
    const tokens = m.info.tokens?.total ?? 0;
    const cost = derivedCost(m.info);

    if (!existing) {
      order.push(id);
      const price = priceFor(m.info.modelID);
      byId.set(id, {
        id,
        name: m.info.agent ?? 'assistant',
        model: {
          id: m.info.modelID ?? 'unknown',
          label: m.info.modelID?.split('/').pop() ?? 'unknown',
          provider: providerOf(m.info.providerID),
          family: familyOf(m.info.modelID),
          pricing: price ? { input: price.input, output: price.output } : undefined,
        },
        status: 'idle',
        focus: m.info.mode,
        tokensUsed: tokens,
        // Placeholder — PageInner overrides via runBudgetCap / pricing (see
        // withTokenBudget in app/page.tsx). Left non-zero so roster ratios
        // don't divide by zero in the mock-data / no-bounds case.
        tokensBudget: 80_000,
        costUsed: cost,
        messagesSent: 1,
        messagesRecv: 0,
        accent: ACCENT_ROTATION[order.length % ACCENT_ROTATION.length],
        glyph: (m.info.agent ?? 'A').charAt(0).toUpperCase(),
        tools: [],
      });
    } else {
      existing.tokensUsed += tokens;
      existing.costUsed += cost;
      existing.messagesSent += 1;
    }

    // infer tools used
    const agent = byId.get(id)!;
    for (const part of m.parts) {
      if (part.type === 'tool') {
        const t = normalizeTool(part.tool);
        if (t && !agent.tools.includes(t)) agent.tools.push(t);
      }
    }
  });

  // Status derivation: walk each agent back to their latest assistant message
  // and classify. `waiting` (pending permission) is layered in by callers that
  // hold the permissions state — toAgents only sees messages.
  const latestMsgIdxByAgent = new Map<string, number>();
  messages.forEach((m, idx) => {
    if (m.info.role !== 'assistant') return;
    latestMsgIdxByAgent.set(agentIdFor(m.info.agent, 'assistant'), idx);
  });
  const overallLastIdx = messages.length - 1;

  for (const [id, msgIdx] of latestMsgIdxByAgent) {
    const agent = byId.get(id);
    if (!agent) continue;
    const last = messages[msgIdx];

    // error trumps all: opencode writes `info.error` on any abnormal turn end
    // (including user-triggered aborts, which are `MessageAbortedError`).
    if (last.info.error) {
      agent.status = 'error';
      continue;
    }

    // someone else spoke after this agent → this agent is just idle
    if (msgIdx !== overallLastIdx) {
      agent.status = 'idle';
      continue;
    }

    // this agent is the session's latest speaker. Distinguish in-progress
    // from completed by whether the info has a completion timestamp.
    const completed = !!last.info.time.completed;
    if (completed) {
      agent.status = 'idle';
      continue;
    }

    // ongoing turn — look at the trailing parts to tell `working` (a tool is
    // executing) from `thinking` (reasoning / no active tool).
    const trailingTool = [...last.parts]
      .reverse()
      .find((p) => p.type === 'tool') as
      | (OpencodePart & { type: 'tool' })
      | undefined;
    const trailingToolState = trailingTool ? toolStateFrom(trailingTool.state) : undefined;
    if (trailingToolState === 'running' || trailingToolState === 'pending') {
      agent.status = 'working';
    } else {
      agent.status = 'thinking';
    }
  }

  return { agents: Array.from(byId.values()), agentOrder: order };
}

export function toMessages(
  messages: OpencodeMessage[]
): AgentMessage[] {
  if (messages.length === 0) return [];
  const anchor = messages[0].info.time.created;
  const out: AgentMessage[] = [];

  // Track most recent assistant agent so user messages route to it
  let lastAssistant: string | undefined;
  for (const m of messages) {
    if (m.info.role === 'assistant') {
      lastAssistant = agentIdFor(m.info.agent, 'assistant');
      break;
    }
  }

  for (const m of messages) {
    const role = m.info.role;
    const fromAgentId = role === 'user' ? 'human' : agentIdFor(m.info.agent, 'assistant');
    if (role === 'assistant') lastAssistant = fromAgentId;
    const toAgentIds =
      role === 'user'
        ? lastAssistant
          ? [lastAssistant]
          : ['human']
        : ['human'];

    for (const part of m.parts) {
      const tMs = (part as { time?: { start: number; end?: number } }).time?.start ?? m.info.time.created;
      const partType = normalizePart(part.type);
      const toolName = part.type === 'tool' ? normalizeTool(part.tool) : undefined;
      const toolState = part.type === 'tool' ? toolStateFrom(part.state) : undefined;
      const interrupted = part.type === 'tool' && isInterruptedTool(part.state);
      const status: AgentMessage['status'] =
        interrupted ? 'abandoned'
        : toolState === 'error' ? 'error'
        : toolState === 'pending' || toolState === 'running' ? 'running'
        : 'complete';

      const partTokens: number | undefined =
        part.type === 'step-finish'
          ? (part.tokens as OpencodeTokenUsage | undefined)?.total
          : undefined;

      out.push({
        id: part.id,
        fromAgentId: isHumanAgentId(fromAgentId) ? 'human' : fromAgentId,
        toAgentIds,
        part: partType,
        toolName,
        toolState,
        title: synthesizeTitle(part),
        body: bodyOf(part),
        toolPreview: previewOf(part),
        timestamp: fmtTs(tMs, anchor),
        duration: fmtDuration(
          (part as { time?: { start: number; end?: number } }).time?.start,
          (part as { time?: { start: number; end?: number } }).time?.end
        ),
        tokens: partTokens,
        status,
        threadId: m.info.id,
      });
    }

    // Mirror opencode's "Interrupted" strip: when the assistant turn is tagged
    // with MessageAbortedError, emit a synthetic row so the timeline shows
    // where the user cancelled.
    if (role === 'assistant' && m.info.error?.name === 'MessageAbortedError') {
      const completedMs = m.info.time.completed ?? m.info.time.created;
      const msg = (m.info.error.data?.message as string | undefined) ?? 'turn cancelled by user';
      out.push({
        id: `${m.info.id}_interrupted`,
        fromAgentId: isHumanAgentId(fromAgentId) ? 'human' : fromAgentId,
        toAgentIds,
        part: 'text',
        title: 'interrupted',
        body: msg,
        timestamp: fmtTs(completedMs, anchor),
        status: 'abandoned',
        threadId: m.info.id,
      });
    }
  }

  return out;
}

export function toRunMeta(
  session: OpencodeSession | null,
  messages: OpencodeMessage[]
): RunMeta {
  let totalTokens = 0;
  let totalCost = 0;
  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    totalTokens += m.info.tokens?.total ?? 0;
    totalCost += m.info.cost ?? 0;
  }

  const startedMs = session?.time.created ?? messages[0]?.info.time.created ?? Date.now();
  const lastMs =
    messages[messages.length - 1]?.info.time.completed ??
    messages[messages.length - 1]?.info.time.created ??
    Date.now();
  const elapsedSec = Math.max(0, Math.floor((lastMs - startedMs) / 1000));
  const elapsed =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : elapsedSec < 3600
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  // "active" when either (a) the last message is a user message — prompt is
  // committed but opencode hasn't attached the assistant message yet, or
  // (b) the last assistant message has no completed timestamp, no error, and
  // was created within ZOMBIE_THRESHOLD_MS. Missing completed + error set
  // means the turn aborted; missing completed + missing error + old means the
  // opencode process died mid-turn. Without the staleness guard, such zombie
  // sessions render "active" with an abort button forever.
  const ZOMBIE_THRESHOLD_MS = 10 * 60 * 1000;
  const lastMessage = messages[messages.length - 1];
  const lastInfo = lastMessage?.info;
  const isRunning =
    !!lastInfo &&
    (lastInfo.role === 'user' ||
      (!lastInfo.time.completed &&
        !lastInfo.error &&
        Date.now() - lastInfo.time.created < ZOMBIE_THRESHOLD_MS));

  return {
    id: session?.id ?? 'run_live',
    title: session?.title ?? 'live session',
    status: isRunning ? 'active' : 'done',
    started: new Date(startedMs).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    elapsed,
    totalTokens,
    totalCost,
    budgetCap: 5.0,
    goTier: { window: '5h', used: 0, cap: 12.0 },
    cwd: session?.directory ?? '',
  };
}

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
      !!t && typeof t === 'object' && typeof (t as RawTodo).content === 'string'
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
      .filter((w) => w.length >= 3 && !TODO_STOPWORDS.has(w))
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
          ? agentIdFor(call.subagentName, 'assistant')
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

// One entry per assistant turn that committed file edits. The diff viewer
// uses this to build the turn list. `files` comes from the patch part, which
// is authoritative for which files this specific turn touched. Diff *text*
// has to be sliced from the session-aggregate response (see filterDiffsForTurn).
export interface LiveTurn {
  id: string;         // messageID of the assistant turn
  sha: string;        // short patch hash — stands in for a git sha in the UI
  title: string;      // first-line of the user prompt that triggered this turn
  summary?: string;   // first-line of the assistant text response, when present
  timestamp: string;  // "HH:MM" local time of turn completion
  agent: string;      // assistant agent name
  status: 'success' | 'in_progress' | 'failure';
  files: string[];    // files this turn touched — from patch.files
  tokens?: number;
  cost?: number;
}

export function toLiveTurns(messages: OpencodeMessage[]): LiveTurn[] {
  const turns: LiveTurn[] = [];
  // Walk messages in pairs — the user prompt that preceded an assistant turn
  // becomes the turn's title, since that's what the human asked for.
  let lastUserText: string | undefined;

  for (const m of messages) {
    if (m.info.role === 'user') {
      const text = firstTextPart(m.parts);
      if (text) lastUserText = text;
      continue;
    }
    if (m.info.role !== 'assistant') continue;

    const patches = m.parts.filter((p): p is Extract<OpencodePart, { type: 'patch' }> => p.type === 'patch');
    if (patches.length === 0) continue;

    const files = Array.from(new Set(patches.flatMap((p) => p.files)));
    const hash = patches[patches.length - 1].hash;
    const responseText = firstTextPart(m.parts);

    const completedMs = m.info.time.completed ?? m.info.time.created;
    const status: LiveTurn['status'] = m.info.error
      ? 'failure'
      : m.info.time.completed
        ? 'success'
        : 'in_progress';

    turns.push({
      id: m.info.id,
      sha: hash.slice(0, 7),
      title: lastUserText ?? responseText ?? 'turn',
      summary: responseText !== lastUserText ? responseText : undefined,
      timestamp: fmtClock(completedMs),
      agent: m.info.agent ?? 'assistant',
      status,
      files,
      tokens: m.info.tokens?.total,
      cost: m.info.cost,
    });
  }

  return turns;
}

function firstTextPart(parts: OpencodePart[]): string | undefined {
  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) return firstLine(p.text, 120);
  }
  return undefined;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

// Parses opencode's unified-diff string into the shape the existing DiffView
// component renders. Tolerates the "Index:" + "====" preamble that opencode
// emits before the standard --- / +++ / @@ hunks.
export function parseUnifiedDiff(file: string, patch: string): DiffData {
  const lines = patch.split(/\r?\n/);
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!match) continue;
      oldLine = parseInt(match[1], 10);
      newLine = parseInt(match[2], 10);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index:') || raw.startsWith('===')) {
      continue;
    }
    if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — skip
      continue;
    }
    const prefix = raw[0];
    const text = raw.slice(1);
    let entry: DiffLine;
    if (prefix === '+') {
      entry = { type: 'add', num: newLine, text };
      newLine += 1;
      additions += 1;
    } else if (prefix === '-') {
      entry = { type: 'remove', num: oldLine, text };
      oldLine += 1;
      deletions += 1;
    } else {
      // space-prefixed context line, or an empty line inside a hunk (treat as context)
      entry = { type: 'context', num: newLine, text };
      oldLine += 1;
      newLine += 1;
    }
    current.lines.push(entry);
  }

  return { file, additions, deletions, hunks };
}

// Opencode's diff endpoint returns the session-aggregate delta per file, not
// per-turn. To scope a turn, filter the aggregate to just the files that turn's
// patch part named. Diff *text* is still session-wide for those files — call
// out that caveat in the UI.
export function parseSessionDiffs(
  diffs: Array<{ file: string; patch: string }>
): DiffData[] {
  return diffs.map((d) => parseUnifiedDiff(d.file, d.patch));
}

export function filterDiffsForTurn(
  allDiffs: DiffData[],
  turnFiles: string[]
): DiffData[] {
  if (turnFiles.length === 0) return [];
  const set = new Set(turnFiles);
  return allDiffs.filter((d) => set.has(d.file));
}

export function toProviderSummary(
  agents: Agent[],
  messages: OpencodeMessage[]
): ProviderSummary[] {
  const byProvider = new Map<Provider, { agents: Set<string>; tokens: number; cost: number }>();

  for (const a of agents) {
    if (!byProvider.has(a.model.provider)) {
      byProvider.set(a.model.provider, { agents: new Set(), tokens: 0, cost: 0 });
    }
    byProvider.get(a.model.provider)!.agents.add(a.id);
  }

  for (const m of messages) {
    if (m.info.role !== 'assistant') continue;
    const provider = providerOf(m.info.providerID);
    if (!byProvider.has(provider)) {
      byProvider.set(provider, { agents: new Set(), tokens: 0, cost: 0 });
    }
    const bucket = byProvider.get(provider)!;
    bucket.tokens += m.info.tokens?.total ?? 0;
    bucket.cost += derivedCost(m.info);
  }

  return Array.from(byProvider.entries()).map(([provider, b]) => ({
    provider,
    agents: b.agents.size,
    tokens: b.tokens,
    cost: b.cost,
  }));
}
