// canonical vocabulary from opencode SDK
// see docs/opencode-vocabulary.md for authoritative source

export type Provider = 'zen' | 'go' | 'byok';

export type AgentRole =
  | 'orchestrator'
  | 'architect'
  | 'coder'
  | 'reviewer'
  | 'researcher'
  | 'operator';

// UI agent status — superset of opencode SessionStatus (idle/busy/retry)
// with extra rendering states for the roster
export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'paused' | 'done' | 'error';

// opencode Session status — exact
export type SessionStatus = 'idle' | 'busy' | 'retry';

// opencode Message Part type discriminators — exact
export type PartType =
  | 'text'
  | 'reasoning'
  | 'tool'
  | 'file'
  | 'agent'
  | 'subtask'
  | 'step-start'
  | 'step-finish'
  | 'snapshot'
  | 'patch'
  | 'retry'
  | 'compaction';

// opencode built-in tool names — exact
export type ToolName =
  | 'bash'
  | 'read'
  | 'write'
  | 'edit'
  | 'list'
  | 'grep'
  | 'glob'
  | 'webfetch'
  | 'todowrite'
  | 'todoread'
  | 'task'; // delegate-to-subagent; opencode's native A2A primitive

// opencode ToolPart state — exact
export type ToolState = 'pending' | 'running' | 'completed' | 'error';

// opencode event types we surface in the UI — exact subset of SDK event names
export type EventType =
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.status'
  | 'session.idle'
  | 'session.compacted'
  | 'session.diff'
  | 'session.error'
  | 'message.updated'
  | 'message.part.updated'
  | 'message.part.removed'
  | 'permission.asked'
  | 'permission.replied'
  | 'permission.updated'
  | 'file.edited'
  | 'todo.updated'
  | 'command.executed';

export interface ModelRef {
  id: string;
  label: string;
  provider: Provider;
  family: 'claude' | 'gpt' | 'gemini' | 'qwen' | 'kimi' | 'glm' | 'mimo' | 'minimax' | 'nemotron';
  pricing?: { input: number; output: number };
  limitTag?: string;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  model: ModelRef;
  status: AgentStatus;
  currentTask?: string;
  tokensUsed: number;
  tokensBudget: number;
  costUsed: number;
  messagesSent: number;
  messagesRecv: number;
  accent: 'molten' | 'mint' | 'iris' | 'amber' | 'fog';
  glyph: string;
  // which opencode tools this agent is configured to call
  tools: ToolName[];
}

// A timeline message corresponds to an opencode MessagePart — with
// from/to extended to model sub-agent delegation (task tool + subtask).
// For a top-level agent's own parts, fromAgentId === the sole toAgentId.
// For a `task` tool call that spawns a sub-agent, toAgentIds = [sub-agent id].
export interface AgentMessage {
  id: string;
  fromAgentId: string | 'human';
  toAgentIds: string[];
  part: PartType;
  // populated when part === 'tool'
  toolName?: ToolName;
  toolState?: ToolState;
  title: string;
  body?: string;
  toolSubtitle?: string;
  toolPreview?: string;
  timestamp: string; // "mm:ss"
  duration?: string;
  tokens?: number;
  cost?: number;
  status: 'complete' | 'running' | 'error' | 'pending' | 'abandoned';
  threadId?: string;
  relatesTo?: string;
  // populated when tool call required human permission
  permission?: {
    tool: ToolName;
    state: 'asked' | 'approved' | 'denied';
  };
}

export interface MissionMeta {
  id: string;
  title: string;
  status: 'active' | 'done' | 'paused' | 'failed';
  started: string;
  elapsed: string;
  totalTokens: number;
  totalCost: number;
  budgetCap: number;
  goTier: { window: '5h' | 'weekly' | 'monthly'; used: number; cap: number };
  cwd: string;
}

export interface ProviderSummary {
  provider: Provider;
  agents: number;
  tokens: number;
  cost: number;
  hint?: string;
}
