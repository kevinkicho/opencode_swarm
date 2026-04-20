// canonical vocabulary from opencode SDK
// see docs/opencode-vocabulary.md for authoritative source

export type Provider = 'zen' | 'go' | 'byok';

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
  model: ModelRef;
  status: AgentStatus;
  // Agent-authored one-liner describing what it's currently working on.
  // Ephemeral, freely updatable, never routed on. Not a role.
  focus?: string;
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

// App-layer todo item — not a native opencode primitive.
// Mirrors what `todowrite` produces but extends it with app-minted binding
// fields (ownerAgentId, taskMessageId) that link the plan to delegations.
// See DESIGN.md §8 for the binding contract.
export type TodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'abandoned';

export interface TodoItem {
  id: string;                  // stable, app-minted todoID
  content: string;             // verbatim plan text
  status: TodoStatus;
  ownerAgentId?: string;       // bound child agent, set when delegated
  taskMessageId?: string;      // AgentMessage.id of the task-tool call that executes it
  parentTodoId?: string;       // non-null for sub-plan items (not rendered in v1)
  note?: string;               // short annotation, e.g. "3 retries"
}

export interface RunMeta {
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
