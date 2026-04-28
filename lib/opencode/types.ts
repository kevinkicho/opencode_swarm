// Shared opencode type definitions. No runtime — safe to import from both
// server and client modules. Keeps `client.ts` (server-only, has env/Buffer)
// and `live.ts` (client-only, hits the proxy) in sync.

export interface OpencodeProject {
  id: string;
  worktree: string;
  vcs?: 'git';
  icon?: { color: string };
  time: { created: number; updated: number };
  sandboxes: unknown[];
}

export interface OpencodeSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  summary?: { additions: number; deletions: number; files: number };
  time: { created: number; updated: number };
}

export type OpencodeRole = 'user' | 'assistant';
export type OpencodePartType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'step-start'
  | 'step-finish'
  | 'patch';

// #7.Q37 — opencode's built-in agent set. POSTs whose `agent` field
// isn't one of these get silently dropped with HTTP 204 (the message
// never persists, no observable event). The trap was documented in
// `reference_opencode_agent_silent_drop.md`; Q33 surfaced a real
// production hit (orchestrator-actions buttons sending agent='orchestrator',
// which silently 204'd every click). Typing it as a union catches
// future regressions at compile time. If opencode adds a new built-in
// agent, add it here. Custom role labels ('orchestrator', 'judge',
// 'auditor', etc.) are NOT opencode agents — they're our internal
// taxonomy and should NOT be passed through this field.
export type OpencodeBuiltinAgent =
  | 'build'
  | 'compaction'
  | 'explore'
  | 'general'
  | 'plan'
  | 'summary'
  | 'title';

export interface OpencodeTokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { write: number; read: number };
}

// Discriminated by `name` — opencode sets this on the assistant message when a
// turn ends abnormally. `MessageAbortedError` = user-triggered cancel.
export interface OpencodeMessageError {
  name: string;
  data?: Record<string, unknown>;
}

export interface OpencodeMessageInfo {
  id: string;
  sessionID: string;
  role: OpencodeRole;
  time: { created: number; completed?: number };
  agent?: string;
  mode?: string;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  path?: { cwd: string; root: string };
  cost?: number;
  tokens?: OpencodeTokenUsage;
  finish?: string;
  error?: OpencodeMessageError;
}

export interface OpencodePartBase {
  type: OpencodePartType;
  id: string;
  sessionID: string;
  messageID: string;
}
export interface OpencodeTextPart extends OpencodePartBase {
  type: 'text';
  text: string;
  time?: { start: number; end: number };
}
export interface OpencodeReasoningPart extends OpencodePartBase {
  type: 'reasoning';
  text: string;
  time?: { start: number; end: number };
  metadata?: { anthropic?: { signature: string } };
}
export interface OpencodeToolPart extends OpencodePartBase {
  type: 'tool';
  tool?: string;
  state?: unknown;
  input?: unknown;
  output?: unknown;
}
export interface OpencodeStepStartPart extends OpencodePartBase {
  type: 'step-start';
  snapshot?: string;
}
export interface OpencodeStepFinishPart extends OpencodePartBase {
  type: 'step-finish';
  snapshot?: string;
  reason: string;
  cost: number;
  tokens: OpencodeTokenUsage;
}
// Emitted once per assistant turn that committed file edits. `files` names the
// files touched in this turn; patch text lives only at the session level via
// GET /session/{id}/diff (probed 2026-04-20: ?messageID=/?hash= are ignored).
export interface OpencodePatchPart extends OpencodePartBase {
  type: 'patch';
  hash: string;
  files: string[];
}
export type OpencodePart =
  | OpencodeTextPart
  | OpencodeReasoningPart
  | OpencodeToolPart
  | OpencodeStepStartPart
  | OpencodeStepFinishPart
  | OpencodePatchPart;

export interface OpencodeMessage {
  info: OpencodeMessageInfo;
  parts: OpencodePart[];
}

// Permission request emitted by opencode when a tool call requires user
// approval. Matches the `Permission` type in opencode's v1.14 SDK
// (packages/sdk/js/src/gen/types.gen.ts):
//
//   { id, type, pattern?, sessionID, messageID, callID?, title, metadata, time }
//
// `type` is the permission kind (e.g. 'bash', 'edit', 'write'); `pattern`
// is the matched glob/path/cmd; `title` is a human-readable summary
// suitable for the strip header. `messageID` and `callID` are top-level
// (pre-v1.14 they nested under `tool`).
export interface OpencodePermissionRequest {
  id: string;
  type: string;
  pattern?: string | readonly string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

export type OpencodePermissionReply = 'once' | 'always' | 'reject';

// ---------------------------------------------------------------------------
// v1.14 supplementary surfaces. These were added when we aligned with v1.14
// (2026-04-27). Slim mirror types — only the fields we surface in the UI;
// the SDK's full types.gen.ts has more keys we ignore.

// `GET /experimental/tool/ids` — live tool catalog (returns string[]; we
// keep it raw to compare against the static ToolName union at startup).
export type OpencodeToolIds = readonly string[];

// `GET /command` — user-defined commands from opencode.json.
export interface OpencodeCommand {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  template: string;
  subtask?: boolean;
}

// `GET /mcp` — status map keyed by server name. The SDK's full McpStatus
// is a discriminated union (connected | disabled | failed | needs-auth |
// needs-client-registration); we only surface the discriminator + name
// in the UI, so this opaque shape is sufficient.
export interface OpencodeMcpStatusEntry {
  type: string;
  [key: string]: unknown;
}
export type OpencodeMcpStatusMap = Record<string, OpencodeMcpStatusEntry>;

// `GET /session/{id}/todo` — session-scoped todo list. Distinct from our
// blackboard plan items; useful as a cross-check.
export interface OpencodeTodo {
  id: string;
  content: string;
  status: string;   // 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: string; // 'high' | 'medium' | 'low'
}

// `GET /config` — full opencode.json effective config. We type only the
// fields we display; everything else passes through untyped.
export interface OpencodeConfig {
  $schema?: string;
  theme?: string;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  share?: 'manual' | 'auto' | 'disabled';
  autoupdate?: boolean | 'notify';
  snapshot?: boolean;
  watcher?: { ignore?: string[] };
  plugin?: string[];
  command?: Record<string, {
    template: string;
    description?: string;
    agent?: string;
    model?: string;
    subtask?: boolean;
  }>;
  [key: string]: unknown;
}
