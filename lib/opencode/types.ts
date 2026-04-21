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
  | 'step-finish';

export interface OpencodeTokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { write: number; read: number };
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
export type OpencodePart =
  | OpencodeTextPart
  | OpencodeReasoningPart
  | OpencodeToolPart
  | OpencodeStepStartPart
  | OpencodeStepFinishPart;

export interface OpencodeMessage {
  info: OpencodeMessageInfo;
  parts: OpencodePart[];
}
