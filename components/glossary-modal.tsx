'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';
import type {
  EventType,
  PartType,
  SessionStatus,
  ToolName,
  ToolState,
} from '@/lib/swarm-types';
import { partHex, partMeta, partOrder, toolMeta, toolOrder } from '@/lib/part-taxonomy';
import { PartChip, ToolChip } from './part-chip';

// Reordered for this glossary so adjacent list items land in the same
// column when rendered column-flow (see PartsSection / ToolsSection).
// Grouping intent: related pairs (step-start/step-finish) and same-hued
// chips (tool/patch, agent/subtask) sit vertically together.
const glossaryPartOrder: PartType[] = [
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

const glossaryToolOrder: ToolName[] = [
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

const SDK_TYPES_URL =
  'https://github.com/sst/opencode/blob/main/packages/sdk/js/src/gen/types.gen.ts';
const DOCS_ROOT = 'https://opencode.ai/docs';

// -------- Part details ---------------------------------------------------

interface PartDetail {
  detail: string;
  carriedBy: string;
}

const partDetails: Record<PartType, PartDetail> = {
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

interface ToolDetail {
  detail: string;
  permission: 'never' | 'sometimes' | 'usually';
}

const toolDetails: Record<ToolName, ToolDetail> = {
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

interface EventDetail {
  detail: string;
}

const eventDetails: Record<EventType, EventDetail> = {
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

const eventGroups: { label: string; events: EventType[] }[] = [
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

interface SessionStatusDetail {
  value: SessionStatus;
  blurb: string;
  transition: string;
  hex: string;
}

const sessionStatuses: SessionStatusDetail[] = [
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

interface ToolStateDetail {
  value: ToolState;
  blurb: string;
  hex: string;
  transition: string;
}

const toolStates: ToolStateDetail[] = [
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

// -------- Modal ---------------------------------------------------------

export function GlossaryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]) =>
    !q || fields.some((f) => f?.toLowerCase().includes(q));

  const filteredParts = useMemo(
    () =>
      glossaryPartOrder.filter((p) =>
        matches(p, partMeta[p].label, partMeta[p].blurb, partDetails[p].detail),
      ),
    [q],
  );
  const filteredTools = useMemo(
    () =>
      glossaryToolOrder.filter((t) =>
        matches(t, toolMeta[t].label, toolMeta[t].blurb, toolDetails[t].detail),
      ),
    [q],
  );
  const filteredEventGroups = useMemo(
    () =>
      eventGroups
        .map((g) => ({
          ...g,
          events: g.events.filter((e) => matches(e, g.label, eventDetails[e].detail)),
        }))
        .filter((g) => g.events.length),
    [q],
  );
  const filteredSessions = useMemo(
    () => sessionStatuses.filter((s) => matches(s.value, s.blurb, s.transition)),
    [q],
  );
  const filteredToolStates = useMemo(
    () => toolStates.filter((s) => matches(s.value, s.blurb, s.transition)),
    [q],
  );

  const eventCount = filteredEventGroups.reduce((n, g) => n + g.events.length, 0);
  const totalMatches =
    filteredParts.length +
    filteredTools.length +
    eventCount +
    filteredSessions.length +
    filteredToolStates.length;

  return (
    <Modal open={open} onClose={onClose} eyebrow="reference" title="opencode vocabulary" width="max-w-[1400px]">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by name or description"
              className="w-full h-8 pl-8 pr-3 rounded bg-ink-900 hairline text-[12.5px] text-fog-100 placeholder:text-fog-700 focus:outline-none focus:border-molten/40 transition font-mono"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-micro text-fog-700">
              /
            </span>
          </div>
          <span className="font-mono text-micro text-fog-700 tabular-nums px-2">
            {q
              ? `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`
              : `${partOrder.length + toolOrder.length + eventGroups.reduce((n, g) => n + g.events.length, 0) + sessionStatuses.length + toolStates.length} entries`}
          </span>
          <a
            href={DOCS_ROOT}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-micro uppercase tracking-wider text-fog-600 hover:text-molten transition h-8 px-3 rounded hairline bg-ink-900 flex items-center"
          >
            docs
          </a>
          <a
            href={SDK_TYPES_URL}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-micro uppercase tracking-wider text-fog-600 hover:text-molten transition h-8 px-3 rounded hairline bg-ink-900 flex items-center"
          >
            types.gen
          </a>
        </div>

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}
        >
          <PartsSection parts={filteredParts} />
          <ToolsSection tools={filteredTools} />
          <EventsSection groups={filteredEventGroups} />
          <StatusSection sessions={filteredSessions} states={filteredToolStates} />
        </div>

        {totalMatches === 0 && <EmptyFilter />}

        <footer className="pt-2 hairline-t font-mono text-micro text-fog-700 leading-relaxed">
          strings from <span className="text-fog-400">packages/sdk/js/src/gen/types.gen.ts</span> ·
          descriptions are this prototype's learning aid, not quotes from opencode docs · hover any row for
          more detail
        </footer>
      </div>
    </Modal>
  );
}

// -------- Shared scaffolding --------------------------------------------

function SectionCard({
  label,
  count,
  hint,
  children,
}: {
  label: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md hairline bg-ink-900/40 overflow-hidden flex flex-col min-h-0">
      <header className="px-3 h-7 flex items-baseline gap-2 hairline-b bg-ink-900/60 shrink-0">
        <span className="font-mono text-micro uppercase tracking-widest2 text-molten">
          {label}
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">{count}</span>
        <span className="ml-auto font-mono text-[10px] text-fog-600 italic truncate">{hint}</span>
      </header>
      <div className="p-1.5 flex-1 min-h-0 overflow-y-auto">{children}</div>
    </section>
  );
}

// -------- Parts section -------------------------------------------------

function PartsSection({ parts }: { parts: PartType[] }) {
  return (
    <SectionCard
      label="parts"
      count={parts.length}
      hint="PartType · message building blocks"
    >
      {parts.length === 0 ? (
        <EmptyHint />
      ) : (
        <ul
          className="grid gap-1"
          style={{
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateRows: `repeat(${Math.ceil(parts.length / 2)}, auto)`,
            gridAutoFlow: 'column',
          }}
        >
          {parts.map((p) => {
            const m = partMeta[p];
            const d = partDetails[p];
            const hex = partHex[p];
            return (
              <li key={p}>
                <Tooltip
                  side="top"
                  wide
                  content={<DeepTooltip title={p} hex={hex} detail={d.detail} meta={[
                    { k: 'via', v: d.carriedBy },
                    { k: 'lane', v: m.crossLane ? 'crosses lanes' : 'in-lane chip' },
                  ]} />}
                >
                  <div className="rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1.5 cursor-help">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-[86px] shrink-0 flex items-center">
                        <PartChip part={p} />
                      </span>
                      <span className="text-[10.5px] text-fog-400 leading-tight truncate flex-1">
                        {m.blurb}
                      </span>
                      <span className="w-[36px] shrink-0 flex items-center justify-start">
                        {m.crossLane && (
                          <span className="font-mono text-[8.5px] uppercase tracking-widest2 text-fog-600">
                            ×lane
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// -------- Tools section -------------------------------------------------

function ToolsSection({ tools }: { tools: ToolName[] }) {
  const permissionLabel = (p: ToolDetail['permission']) =>
    p === 'never' ? 'auto' : p === 'sometimes' ? 'sometimes' : 'prompts';
  const permissionTone = (p: ToolDetail['permission']) =>
    p === 'never' ? 'text-mint' : p === 'sometimes' ? 'text-amber' : 'text-molten';

  return (
    <SectionCard
      label="tools"
      count={tools.length}
      hint="ToolName · 11 built-ins"
    >
      {tools.length === 0 ? (
        <EmptyHint />
      ) : (
        <ul
          className="grid gap-1"
          style={{
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateRows: `repeat(${Math.ceil(tools.length / 2)}, auto)`,
            gridAutoFlow: 'column',
          }}
        >
          {tools.map((t) => {
            const m = toolMeta[t];
            const d = toolDetails[t];
            return (
              <li key={t}>
                <Tooltip
                  side="top"
                  wide
                  content={<DeepTooltip title={t} hex={m.hex} detail={d.detail} meta={[
                    { k: 'permission', v: d.permission === 'never' ? 'never prompts' : d.permission === 'sometimes' ? 'depends on config' : 'usually prompts' },
                    ...(t === 'task' ? [{ k: 'role', v: 'native A2A primitive' }] : []),
                  ]} />}
                >
                  <div className="rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1.5 cursor-help">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-[74px] shrink-0 flex items-center">
                        <ToolChip tool={t} />
                      </span>
                      <span className="text-[10.5px] text-fog-400 leading-tight truncate flex-1">
                        {m.blurb}
                      </span>
                      <span className="w-[64px] shrink-0 flex items-center justify-start">
                        {t === 'task' ? (
                          <span className="font-mono text-[8.5px] uppercase tracking-widest2 text-molten">
                            A2A
                          </span>
                        ) : (
                          <span className={clsx('font-mono text-[8.5px] uppercase tracking-widest2', permissionTone(d.permission))}>
                            {permissionLabel(d.permission)}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// -------- Events section ------------------------------------------------

function EventsSection({ groups }: { groups: { label: string; events: EventType[] }[] }) {
  const total = groups.reduce((n, g) => n + g.events.length, 0);
  return (
    <SectionCard
      label="events"
      count={total}
      hint="EventType · SSE stream"
    >
      {groups.length === 0 ? (
        <EmptyHint />
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}
        >
          {groups.map((g) => (
            <div key={g.label} className="min-w-0">
              <div className="px-1 mb-1 flex items-baseline gap-1.5 hairline-b pb-1">
                <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
                  {g.label}
                </span>
                <span className="font-mono text-[9px] text-fog-700 tabular-nums ml-auto">
                  {g.events.length}
                </span>
              </div>
              <ul className="space-y-0.5">
                {g.events.map((e) => {
                  const d = eventDetails[e];
                  return (
                    <li key={e}>
                      <Tooltip side="top" wide content={<DeepTooltip title={e} detail={d.detail} meta={[]} />}>
                        <div className="rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1 cursor-help">
                          <code className="font-mono text-[10.5px] text-fog-200 block truncate">
                            {e}
                          </code>
                        </div>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// -------- Status section ------------------------------------------------

function StatusSection({
  sessions,
  states,
}: {
  sessions: SessionStatusDetail[];
  states: ToolStateDetail[];
}) {
  return (
    <SectionCard
      label="status"
      count={sessions.length + states.length}
      hint="SessionStatus + ToolState"
    >
      {sessions.length + states.length === 0 ? (
        <EmptyHint />
      ) : (
        (() => {
          const cols = [
            sessions.length > 0 && {
              key: 'session.status',
              label: 'session.status',
              count: sessions.length,
              rows: sessions,
            },
            states.length > 0 && {
              key: 'tool.state',
              label: 'tool state',
              count: states.length,
              rows: states,
            },
          ].filter(Boolean) as {
            key: string;
            label: string;
            count: number;
            rows: (SessionStatusDetail | ToolStateDetail)[];
          }[];
          return (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}
            >
              {cols.map((c) => (
                <div key={c.key} className="min-w-0">
                  <div className="px-1 mb-1 flex items-baseline gap-1.5 hairline-b pb-1">
                    <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
                      {c.label}
                    </span>
                    <span className="font-mono text-[9px] text-fog-700 tabular-nums ml-auto">
                      {c.count}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {c.rows.map((s) => (
                      <StatusRow
                        key={s.value}
                        value={s.value}
                        hex={s.hex}
                        blurb={s.blurb}
                        transition={s.transition}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          );
        })()
      )}
    </SectionCard>
  );
}

function StatusRow({
  value,
  hex,
  blurb,
  transition,
}: {
  value: string;
  hex: string;
  blurb: string;
  transition: string;
}) {
  return (
    <li>
      <Tooltip
        side="top"
        wide
        content={<DeepTooltip title={value} hex={hex} detail={blurb} meta={[{ k: 'next', v: transition }]} />}
      >
        <div className="flex items-center gap-2 rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1 cursor-help">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: hex }}
          />
          <span className="w-[76px] shrink-0 flex items-center">
            <code
              className="font-mono text-[10.5px] uppercase tracking-widest2"
              style={{ color: hex }}
            >
              {value}
            </code>
          </span>
          <span className="text-[10.5px] text-fog-400 leading-tight truncate flex-1">
            {blurb}
          </span>
        </div>
      </Tooltip>
    </li>
  );
}

// -------- Shared tooltip + empty ----------------------------------------

function DeepTooltip({
  title,
  hex,
  detail,
  meta,
}: {
  title: string;
  hex?: string;
  detail: string;
  meta: { k: string; v: string }[];
}) {
  return (
    <div className="space-y-1.5 max-w-[300px]">
      <div className="flex items-center gap-2">
        {hex && (
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: hex }}
          />
        )}
        <code
          className="font-mono text-[11.5px] tracking-tight"
          style={{ color: hex ?? '#cfd6df' }}
        >
          {title}
        </code>
      </div>
      <div className="text-[11px] text-fog-300 leading-relaxed">{detail}</div>
      {meta.length > 0 && (
        <div className="pt-1 hairline-t space-y-0.5">
          {meta.map((r) => (
            <div key={r.k} className="flex items-baseline gap-2 font-mono text-[10.5px]">
              <span className="text-fog-700 uppercase tracking-widest2 whitespace-nowrap shrink-0">
                {r.k}
              </span>
              <span className="text-fog-400 flex-1 leading-relaxed">{r.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="py-3 text-center font-mono text-micro text-fog-700">no matches here</div>
  );
}

function EmptyFilter() {
  return (
    <div className="py-6 text-center">
      <div className="font-display italic text-[15px] text-fog-500">no matches</div>
      <div className="mt-1 font-mono text-micro text-fog-700">try a different query</div>
    </div>
  );
}
