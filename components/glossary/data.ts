// Glossary data tables — opencode SDK vocabulary the modal renders.
//
// Extracted from glossary-modal.tsx in #108. Pure data, no UI; tests
// (or future doc-generation passes) can read from here without
// importing React. Copy preserved verbatim from the original modal.

import type {
  EventType,
  PartType,
  SessionStatus,
  ToolName,
  ToolState,
} from '@/lib/swarm-types';

export const SDK_TYPES_URL =
  'https://github.com/sst/opencode/blob/main/packages/sdk/js/src/gen/types.gen.ts';
export const DOCS_ROOT = 'https://opencode.ai/docs';

// Reordered for this glossary so adjacent list items land in the same
// column when rendered column-flow (see PartsSection / ToolsSection).
// Grouping intent: related pairs (step-start/step-finish) and same-hued
// chips (tool/patch, agent/subtask) sit vertically together.
export const glossaryPartOrder: PartType[] = [
  'text',
  'reasoning',
  'tool',
  'patch',
  'step-start',
  'step-finish',
  'agent',
  'subtask',
  'snapshot',
  'file',
  'retry',
  'compaction',
];

export const glossaryToolOrder: ToolName[] = [
  'read',
  'list',
  'grep',
  'glob',
  'webfetch',
  'bash',
  'edit',
  'write',
  'todoread',
  'todowrite',
  'task',
];

// -------- Part details ---------------------------------------------------

export interface PartDetail {
  detail: string;
  carriedBy: string;
}

export const partDetails: Record<PartType, PartDetail> = {
  text: {
    detail:
      'Plain model output (assistant) or plain human prompt (user). Usually markdown. The default part you see in chat transcripts.',
    carriedBy: 'message.part.updated',
  },
  reasoning: {
    detail:
      'Internal "chain-of-thought" produced by reasoning-capable models. Not shown to end-users by default, but surfaced here so you can see why an agent took an action.',
    carriedBy: 'message.part.updated',
  },
  tool: {
    detail:
      'A single tool invocation and its result packaged together. Sub-fields like toolName, state, input and output hang off this part.',
    carriedBy: 'message.part.updated',
  },
  file: {
    detail:
      'Reference to a file in the project — either an attachment the user included or a file the model asked about.',
    carriedBy: 'message.part.updated',
  },
  agent: {
    detail:
      'Identifies which sub-agent produced the surrounding message. Appears on messages emitted by a sub-agent session.',
    carriedBy: 'message.part.updated',
  },
  subtask: {
    detail:
      "Return value of a delegated task. Correlates back to the task tool call that spawned the sub-agent; body is the sub-agent's final summary.",
    carriedBy: 'message.part.updated',
  },
  'step-start': {
    detail:
      'Boundary marker opening a "step" (a reasoning chunk plus the tool calls it decides to make). Also the point at which opencode takes a working-tree snapshot.',
    carriedBy: 'message.part.updated',
  },
  'step-finish': {
    detail:
      'Boundary marker closing a step. Pairs with step-start; the timeline uses these for checkpoint rows.',
    carriedBy: 'message.part.updated',
  },
  snapshot: {
    detail:
      "Captured working-tree state at a step boundary. Enables opencode's revert/undo without touching your git history.",
    carriedBy: 'message.part.updated',
  },
  patch: {
    detail:
      'Materialized code change expressed as a diff. Often accompanies an edit/write tool part.',
    carriedBy: 'message.part.updated',
  },
  retry: {
    detail:
      'Marker that the previous turn failed and is being retried. Pairs with session.status = retry.',
    carriedBy: 'message.part.updated',
  },
  compaction: {
    detail:
      'Marker that the context window was compacted to free tokens. Everything before this point is summarized, not raw.',
    carriedBy: 'session.compacted',
  },
};

// -------- Tool details ---------------------------------------------------

export interface ToolDetail {
  detail: string;
  permission: 'never' | 'sometimes' | 'usually';
}

export const toolDetails: Record<ToolName, ToolDetail> = {
  bash: {
    detail:
      'Executes a shell command. Opencode asks for permission unless the command matches an allow-listed read-only pattern in your config.',
    permission: 'usually',
  },
  read: {
    detail:
      'Reads a file (or a portion of one) from the project. Cheap and safe — no permission prompt.',
    permission: 'never',
  },
  write: {
    detail:
      'Overwrites a file wholesale. Asks for permission by default because it can clobber unsaved work.',
    permission: 'usually',
  },
  edit: {
    detail:
      'Surgical string-replace edit against an existing file. Safer than write because the old_string must match exactly; still prompts for permission by default.',
    permission: 'usually',
  },
  list: {
    detail:
      'Lists a directory (like `ls`). Used to orient in the project or discover file paths.',
    permission: 'never',
  },
  grep: {
    detail:
      'Content search powered by ripgrep. Read-only — runs pattern matches across files.',
    permission: 'never',
  },
  glob: {
    detail:
      'Filename pattern match (e.g. `src/**/*.ts`). Read-only discovery tool that returns matching paths.',
    permission: 'never',
  },
  webfetch: {
    detail:
      'Fetches a URL and converts it to agent-friendly markdown. Good for pulling docs or reference material into context.',
    permission: 'sometimes',
  },
  todowrite: {
    detail:
      "Writes or updates the session's todo list. Agents use this to plan multi-step work and track progress.",
    permission: 'never',
  },
  todoread: {
    detail: "Reads the session's todo list back to the model so it can re-plan.",
    permission: 'never',
  },
  task: {
    detail:
      "Spawns (or resumes) a sub-agent session and returns its result. This is opencode's native agent-to-agent primitive — there is no separate typed-pin schema.",
    permission: 'never',
  },
};

// -------- Event details --------------------------------------------------

export interface EventDetail {
  detail: string;
}

export const eventDetails: Record<EventType, EventDetail> = {
  'session.created': {
    detail:
      'A brand new session was created — either by the user or by a task tool call that spawned a sub-agent.',
  },
  'session.updated': { detail: 'Session metadata changed (title, cost, token totals).' },
  'session.deleted': {
    detail:
      'A session was deleted. Sub-agent sessions are usually deleted when their parent terminates.',
  },
  'session.status': {
    detail:
      'Session transitioned between idle / busy / retry. See the status section for transitions.',
  },
  'session.idle': {
    detail:
      'Session finished working and has nothing queued. Good signal for "show the final answer."',
  },
  'session.compacted': {
    detail:
      'Context was compacted to fit the model window. Older turns are summarized into a single synthetic part.',
  },
  'session.diff': {
    detail:
      'A diff is available for the session (cumulative project changes since the session started).',
  },
  'session.error': { detail: 'Session errored in a way that aborts the current turn.' },
  'message.updated': {
    detail:
      'The top-level message container changed — usually because a part was appended or its metadata was patched.',
  },
  'message.part.updated': {
    detail:
      'The primary streaming event. Fired whenever a part is added or an existing part changes (e.g. tool result lands, text streams in).',
  },
  'message.part.removed': {
    detail: 'A part was removed — rare, but happens on revert or on failed streaming chunks.',
  },
  'permission.asked': {
    detail:
      'A tool call is blocked waiting on human approval. Surface this prominently — the agent is idle until you decide.',
  },
  'permission.replied': {
    detail:
      'Human replied to a permission request (approved or denied). The tool call proceeds or aborts accordingly.',
  },
  'permission.updated': {
    detail:
      'Permission metadata changed — for example, the scope of an approval was adjusted.',
  },
  'file.edited': {
    detail:
      'A file was written or edited by a tool call. Useful for keeping an in-memory view of the working tree fresh.',
  },
  'todo.updated': {
    detail: "The session's todo list changed. Mirror into your UI to show agent planning.",
  },
  'command.executed': {
    detail:
      'A shell command finished — carries the exit code and output. Pairs with a bash tool part.',
  },
};

export const eventGroups: { label: string; events: EventType[] }[] = [
  {
    label: 'session',
    events: [
      'session.created',
      'session.updated',
      'session.deleted',
      'session.status',
      'session.idle',
      'session.compacted',
      'session.diff',
      'session.error',
    ],
  },
  { label: 'message', events: ['message.updated', 'message.part.updated', 'message.part.removed'] },
  { label: 'permission', events: ['permission.asked', 'permission.replied', 'permission.updated'] },
  { label: 'file / cmd / todo', events: ['file.edited', 'todo.updated', 'command.executed'] },
];

// -------- Status details -------------------------------------------------

export interface SessionStatusDetail {
  value: SessionStatus;
  blurb: string;
  transition: string;
  hex: string;
}

export const sessionStatuses: SessionStatusDetail[] = [
  {
    value: 'idle',
    blurb: 'waiting for input',
    transition: 'becomes busy when you send a prompt or spawn a sub-agent.',
    hex: '#7d8798',
  },
  {
    value: 'busy',
    blurb: 'producing a message',
    transition: 'becomes idle on completion, or retry on a retriable error.',
    hex: '#ff7a3d',
  },
  {
    value: 'retry',
    blurb: 'last turn failed, retrying',
    transition: 'becomes busy as soon as the retry attempt starts.',
    hex: '#fbbf24',
  },
];

export interface ToolStateDetail {
  value: ToolState;
  blurb: string;
  hex: string;
  transition: string;
}

export const toolStates: ToolStateDetail[] = [
  {
    value: 'pending',
    blurb: 'queued, awaiting approval',
    hex: '#fbbf24',
    transition: 'becomes running once approved, or error if denied.',
  },
  {
    value: 'running',
    blurb: 'executing now',
    hex: '#ff7a3d',
    transition: 'becomes completed or error when the tool returns.',
  },
  {
    value: 'completed',
    blurb: 'finished successfully',
    hex: '#5eead4',
    transition: 'terminal — ToolPart is sealed.',
  },
  {
    value: 'error',
    blurb: 'finished with an error',
    hex: '#f87171',
    transition: 'terminal — ToolPart is sealed; agent sees error text.',
  },
];
