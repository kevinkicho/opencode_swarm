'use client';

// HARDENING_PLAN.md#C14 — retro-view decomposition.
//
// Per-agent blocks for the retro view. Lifted from retro-view.tsx so
// the main file reads as the run-level concerns (header / overview /
// lessons / artifact graph) without scrolling past the agent-card
// machinery. Each agent's rollup → AgentRollupCard → PlanBlock /
// DetailBlock / Counter for sub-rows.
//
// The pattern: AgentSection wraps a list of AgentRollupCard; each card
// renders (counters, plan, artifacts, failures, decisions, deps).
// Counters sit inline; everything else uses DetailBlock for the
// "label header → indented rows" shape.

import clsx from 'clsx';

import type { AgentRollup } from '@/lib/server/memory/types';
import { OUTCOME_TONE, fmtTokens } from './_shared';

// Per-status affordance for plan items. Mirrors the run-roster palette so a
// completed todo reads as "done" without second-guessing.
const PLAN_STATUS_TONE: Record<string, { dot: string; text: string }> = {
  completed:   { dot: 'bg-mint',   text: 'text-mint' },
  in_progress: { dot: 'bg-iris animate-pulse', text: 'text-iris' },
  pending:     { dot: 'bg-fog-700', text: 'text-fog-400' },
  failed:      { dot: 'bg-rust',   text: 'text-rust' },
  abandoned:   { dot: 'bg-fog-700', text: 'text-fog-600 line-through' },
};

export function AgentSection({ rollups }: { rollups: AgentRollup[] }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          per-agent rollups
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">
          {rollups.length}
        </span>
      </div>
      {rollups.length === 0 ? (
        <div className="px-3 py-4 font-mono text-[11px] text-fog-600">
          no agent rollups recorded — either the run never dispatched a session,
          or the rollup generator hasn't run yet.
        </div>
      ) : (
        <ul className="divide-y divide-ink-800">
          {rollups.map((r) => (
            <AgentRollupCard key={r.sessionID} rollup={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentRollupCard({ rollup }: { rollup: AgentRollup }) {
  const tone = OUTCOME_TONE[rollup.outcome] ?? OUTCOME_TONE.partial;

  // Build todo-id → (index, content) lookup so an artifact's originTodoID can
  // render as `todo·N` with a hover tooltip showing the full todo content.
  // Index is 1-based and matches the order of the plan list below.
  const planIndex = new Map<string, { index: number; content: string }>();
  if (rollup.plan) {
    rollup.plan.forEach((t, i) => {
      planIndex.set(t.id, { index: i + 1, content: t.content });
    });
  }

  // Count artifacts per todo so the plan block can show weight at a glance.
  const artifactsPerTodo = new Map<string, number>();
  for (const a of rollup.artifacts) {
    if (a.originTodoID) {
      artifactsPerTodo.set(a.originTodoID, (artifactsPerTodo.get(a.originTodoID) ?? 0) + 1);
    }
  }

  return (
    <li className="px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 shrink-0">
          <span className={clsx('w-1.5 h-1.5 rounded-full', tone.dot)} />
          <span
            className={clsx(
              'font-mono text-micro uppercase tracking-widest2',
              tone.text
            )}
          >
            {rollup.outcome}
          </span>
        </span>
        <span className="font-mono text-[11.5px] text-fog-100 font-medium">
          {rollup.agent.name}
        </span>
        {rollup.agent.model && (
          <span className="font-mono text-[10px] text-fog-600">
            {rollup.agent.model}
          </span>
        )}
        <span className="font-mono text-[10px] text-fog-700 tabular-nums ml-auto truncate">
          {rollup.sessionID}
        </span>
      </div>

      <div className="flex items-center gap-3 font-mono text-[10.5px] tabular-nums">
        <Counter label="in" value={fmtTokens(rollup.counters.tokensIn)} />
        <Counter label="out" value={fmtTokens(rollup.counters.tokensOut)} />
        <Counter label="tools" value={`${rollup.counters.toolCalls}`} />
        <Counter
          label="retries"
          value={`${rollup.counters.retries}`}
          tone={rollup.counters.retries > 0 ? 'text-amber' : undefined}
        />
        <Counter
          label="compact"
          value={`${rollup.counters.compactions}`}
          tone={rollup.counters.compactions > 0 ? 'text-iris' : undefined}
        />
      </div>

      {rollup.plan && rollup.plan.length > 0 && (
        <PlanBlock plan={rollup.plan} artifactsPerTodo={artifactsPerTodo} />
      )}

      {rollup.artifacts.length > 0 && (
        <DetailBlock label={`artifacts (${rollup.artifacts.length})`}>
          {rollup.artifacts.slice(0, 10).map((a, i) => {
            const bound = a.originTodoID ? planIndex.get(a.originTodoID) : undefined;
            return (
              <span
                key={i}
                className="flex items-center gap-2 h-5 px-2 hover:bg-ink-800/60 transition rounded"
              >
                <span
                  className={clsx(
                    'font-mono text-[9px] uppercase tracking-widest2 w-[38px] shrink-0',
                    a.status === 'merged'
                      ? 'text-mint'
                      : a.status === 'discarded'
                        ? 'text-rust'
                        : 'text-fog-600'
                  )}
                >
                  {a.type}
                </span>
                <span className="font-mono text-[10.5px] text-fog-200 truncate flex-1 min-w-0">
                  {a.filePath ?? '—'}
                </span>
                {bound && (
                  <span
                    title={bound.content}
                    className="font-mono text-[9px] uppercase tracking-widest2 text-iris/80 border border-iris/20 bg-iris/5 rounded px-1 h-3.5 flex items-center shrink-0"
                  >
                    todo·{bound.index}
                  </span>
                )}
                {(a.addedLines !== undefined || a.removedLines !== undefined) && (
                  <span className="font-mono text-[9.5px] tabular-nums shrink-0">
                    {a.addedLines !== undefined && (
                      <span className="text-mint">+{a.addedLines}</span>
                    )}
                    {a.removedLines !== undefined && (
                      <span className="text-rust ml-1">-{a.removedLines}</span>
                    )}
                  </span>
                )}
              </span>
            );
          })}
          {rollup.artifacts.length > 10 && (
            <span className="px-2 h-4 font-mono text-[10px] text-fog-600">
              …{rollup.artifacts.length - 10} more
            </span>
          )}
        </DetailBlock>
      )}

      {rollup.failures.length > 0 && (
        <DetailBlock label={`failures (${rollup.failures.length})`}>
          {rollup.failures.slice(0, 8).map((f, i) => (
            <span
              key={i}
              className="flex items-center gap-2 h-5 px-2 hover:bg-ink-800/60 transition rounded"
            >
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-rust w-[60px] shrink-0 truncate">
                {f.tool}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 shrink-0">
                {f.resolution}
              </span>
              {f.routedTo && (
                <span className="font-mono text-[10px] text-iris shrink-0">
                  → {f.routedTo}
                </span>
              )}
              {f.argsHash && (
                <span className="font-mono text-[9.5px] text-fog-700 tabular-nums ml-auto shrink-0">
                  {f.argsHash}
                </span>
              )}
            </span>
          ))}
          {rollup.failures.length > 8 && (
            <span className="px-2 h-4 font-mono text-[10px] text-fog-600">
              …{rollup.failures.length - 8} more
            </span>
          )}
        </DetailBlock>
      )}

      {rollup.decisions.length > 0 && (
        <DetailBlock label={`decisions (${rollup.decisions.length})`}>
          {rollup.decisions.slice(0, 5).map((d, i) => (
            <span
              key={i}
              className="flex items-start gap-2 px-2 py-1 hover:bg-ink-800/60 transition rounded"
            >
              <span className="font-mono text-[9.5px] text-fog-700 tabular-nums shrink-0 pt-0.5">
                {new Date(d.at).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </span>
              <span className="font-mono text-[11px] text-fog-200 leading-snug flex-1 min-w-0">
                {d.choice}
              </span>
            </span>
          ))}
          {rollup.decisions.length > 5 && (
            <span className="px-2 h-4 font-mono text-[10px] text-fog-600">
              …{rollup.decisions.length - 5} more
            </span>
          )}
        </DetailBlock>
      )}

      {rollup.deps.spawned.length > 0 && (
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className="uppercase tracking-widest2 text-fog-700">spawned</span>
          <span className="text-fog-500 tabular-nums">
            {rollup.deps.spawned.length} child session
            {rollup.deps.spawned.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
    </li>
  );
}

function PlanBlock({
  plan,
  artifactsPerTodo,
}: {
  plan: NonNullable<AgentRollup['plan']>;
  artifactsPerTodo: Map<string, number>;
}) {
  const completed = plan.filter((t) => t.status === 'completed').length;
  return (
    <DetailBlock label={`plan (${completed}/${plan.length})`}>
      {plan.map((t, i) => {
        const tone = PLAN_STATUS_TONE[t.status] ?? PLAN_STATUS_TONE.pending;
        const count = artifactsPerTodo.get(t.id) ?? 0;
        return (
          <span
            key={t.id}
            className="flex items-center gap-2 h-5 px-2 hover:bg-ink-800/60 transition rounded"
          >
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 tabular-nums w-[22px] shrink-0">
              t·{i + 1}
            </span>
            <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', tone.dot)} />
            <span
              className={clsx(
                'font-mono text-[10.5px] truncate flex-1 min-w-0',
                tone.text
              )}
            >
              {t.content}
            </span>
            {count > 0 && (
              <span className="font-mono text-[9.5px] tabular-nums text-fog-600 shrink-0">
                {count} patch{count === 1 ? '' : 'es'}
              </span>
            )}
          </span>
        );
      })}
    </DetailBlock>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="uppercase tracking-widest2 text-fog-700">{label}</span>
      <span className={clsx('tabular-nums', tone ?? 'text-fog-300')}>{value}</span>
    </span>
  );
}

function DetailBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700 px-1">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}
