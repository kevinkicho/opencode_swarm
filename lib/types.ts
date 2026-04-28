export type NodeStatus = 'complete' | 'running' | 'abandoned' | 'error' | 'pending';

export type NodeKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'agent'
  | 'decision'
  | 'milestone';

// Legacy mock-data tool kind. Mirrors lib/swarm-types.ts ToolName, kept
// in sync with v1.14.28 — but ToolKind itself is only referenced inside
// this file's TimelineNode/ChatMessage shapes (legacy mock-fixture types
// that haven't been folded into swarm-types yet). Drop this whole file
// once mock-fixture timeline rendering is replaced by the live transform.
export type ToolKind =
  | 'read'
  | 'write'
  | 'edit'
  | 'apply_patch'
  | 'bash'
  | 'grep'
  | 'glob'
  | 'codesearch'
  | 'webfetch'
  | 'websearch'
  | 'todowrite'
  | 'task'
  | 'question'
  | 'skill';

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  num: number | string;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffData {
  file: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface TimelineNode {
  id: string;
  kind: NodeKind;
  toolKind?: ToolKind;
  title: string;
  subtitle?: string;
  preview?: string;
  timestamp: string; // e.g. "00:12"
  duration?: string; // e.g. "1.2s"
  status: NodeStatus;
  tokens?: number;
  diff?: DiffData;
  bashOutput?: string;
  bashCommand?: string;
  thinking?: string;
  agentName?: string;
  agentChildren?: string[]; // ids of child nodes (for visual nesting)
  branch?: {
    chosenLabel: string;
    abandonedLabel: string;
    abandonedReason: string;
  };
  isInBranch?: 'chosen' | 'abandoned';
  relatedChatId?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: string;
  toolRefs?: { id: string; label: string; tool: ToolKind }[];
}

export interface SessionMeta {
  id: string;
  title: string;
  started: string;
  model: string;
  status: 'active' | 'complete' | 'paused';
  tokens: number;
  cost: string;
  elapsed: string;
  branch: string; // git branch
  cwd: string;
}

export interface RecentSession {
  id: string;
  title: string;
  ago: string;
  status: 'active' | 'complete' | 'paused' | 'error';
  model: string;
}
