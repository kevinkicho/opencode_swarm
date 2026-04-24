// canonical vocabulary from opencode SDK
// see docs/opencode-vocabulary.md for authoritative source

// Three provider tiers, all routed through opencode:
//   zen    — opencode's pay-per-token marketplace (Claude, GPT, Gemini, …)
//   go     — opencode subscription bundle (qwen/kimi/glm/minimax under one ceiling)
//   ollama — ollama.com subscription (ollama max plan: nemotron, gemma, kimi,
//            glm, mistral — all `:cloud` variants). User configures opencode
//            for ollama via opencode.json; the app surfaces it as a selectable
//            tier so cost/session distribution shows the three-way split.
// `byok` remains in the union for backwards compatibility with old meta.json
// entries + the read-only inspector's model catalog display (opencode may
// expose BYOK-configured models). Not selectable from creation surfaces.
// History: zen+go-only was the load-bearing stance through 2026-04-23;
// reversed 2026-04-24 after opencode-go ceilings + opencode-zen PPT both
// proved less economical than the ollama-max subscription shape.
export type Provider = 'zen' | 'go' | 'ollama' | 'byok';

// Run-wide orchestration shape. `none` is opencode native (one session,
// task-tool for sub-agents). Others are coordinator-above-opencode presets
// defined in SWARM_PATTERNS.md. Presence of a pattern type does NOT imply a
// backend exists — `lib/swarm-patterns.ts` carries the `available` flag.
export type SwarmPattern =
  | 'none'
  | 'blackboard'
  | 'map-reduce'
  | 'council'
  | 'orchestrator-worker'
  | 'role-differentiated'
  | 'debate-judge'
  | 'critic-loop'
  | 'deliberate-execute';

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
  family: 'claude' | 'gpt' | 'gemini' | 'qwen' | 'kimi' | 'glm' | 'mimo' | 'minimax' | 'nemotron' | 'gemma' | 'mistral';
  pricing?: { input: number; output: number };
  limitTag?: string;
}

export interface Agent {
  id: string;
  // Opencode sessionID that owns this agent, set by toAgents for live
  // data. Undefined in mock fixtures. Lookups that need to go from a
  // sessionID (heat rail, turn cards) to its agent should use this —
  // agent.id itself is derived (ag_<name>_<last8>) and isn't the
  // sessionID.
  sessionID?: string;
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
  timestamp: string; // "mm:ss" relative to run anchor (compact display)
  tsMs?: number;     // absolute ms since epoch — used by the timeline gutter
                     // for HH:MM:SS wall-clock + full-date tooltip. Optional
                     // because mock fixtures don't carry wall time.
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
  cwd: string;
}

export interface ProviderSummary {
  provider: Provider;
  agents: number;
  tokens: number;
  cost: number;
  hint?: string;
}
