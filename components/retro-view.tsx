'use client';

// Read-only retro viewer for a single swarm run. Renders RunRetro +
// AgentRollup data as dense cards — header summarizes the run, lessons
// come next (the load-bearing field per DESIGN.md §7.4), then one card
// per participating session.
//
// No write actions. No "edit lesson", no "rerun rollup from here".
// Retention / regeneration are backend concerns (see DESIGN.md §7.7 and
// §7.6). If a retro looks stale, hit POST /api/swarm/memory/rollup from
// the terminal — this view is pure observation.
//
// Layout contract (dense-factory aesthetic):
//   - h-5/h-6 header rows with text-micro uppercase tracking-widest2
//   - monospace + tabular-nums for anything numeric
//   - hairline borders only; no drop shadows except card container
//   - outcome drives accent color: merged=mint, partial=amber,
//     aborted/failed=rust, default=fog
//
// Not a client-polled surface — the underlying rollups table only changes
// when someone POSTs /api/swarm/memory/rollup. Re-fetch on navigation.

import clsx from 'clsx';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import type { AgentRollup, RunRetro } from '@/lib/server/memory/types';
import type { TickerSnapshot } from '@/lib/blackboard/live';

interface Props {
  swarmRunID: string;
  retro: RunRetro | null;
  agentRollups: AgentRollup[];
  // #7.Q40 — ticker snapshot for failure-mode runs. When stopped with
  // a failure stopReason (opencode-frozen / zen-rate-limit /
  // replan-loop-exhausted), the header surfaces a prominent chip
  // showing "stopped at min N · <reason>" so the user doesn't have
  // to read the retro body to find out a run silently died. Null when
  // the run has no ticker (non-blackboard pattern, fresh process post-
  // restart, etc.) — header simply omits the failure chip.
  ticker?: TickerSnapshot | null;
}

// Stop reasons that indicate the run hit a failure mode (vs a graceful
// cap or operator action). Mirrors the set used in deriveRunRow's Q35
// classifier — keep these in sync if either side adds a new reason.
const FAILURE_STOP_REASONS = new Set<string>([
  'opencode-frozen',
  'zen-rate-limit',
  'replan-loop-exhausted',
]);

function isFailureStop(ticker: TickerSnapshot | null | undefined): boolean {
  if (!ticker || !ticker.stopped || !ticker.stopReason) return false;
  return FAILURE_STOP_REASONS.has(ticker.stopReason);
}

function fmtMinutes(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

function fmtAbsTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const OUTCOME_TONE: Record<string, { dot: string; text: string }> = {
  completed: { dot: 'bg-mint', text: 'text-mint' },
  merged:    { dot: 'bg-mint', text: 'text-mint' },
  partial:   { dot: 'bg-amber', text: 'text-amber' },
  discarded: { dot: 'bg-fog-500', text: 'text-fog-400' },
  aborted:   { dot: 'bg-rust', text: 'text-rust' },
  failed:    { dot: 'bg-rust', text: 'text-rust' },
};

const LESSON_TONE: Record<string, string> = {
  'tool-failure':    'text-rust border-rust/30 bg-rust/5',
  'routing-miss':    'text-amber border-amber/30 bg-amber/5',
  'good-pattern':    'text-mint border-mint/30 bg-mint/5',
  'user-correction': 'text-iris border-iris/30 bg-iris/5',
};

// Per-status affordance for plan items. Mirrors the run-roster palette so a
// completed todo reads as "done" without second-guessing.
const PLAN_STATUS_TONE: Record<string, { dot: string; text: string }> = {
  completed:   { dot: 'bg-mint',   text: 'text-mint' },
  in_progress: { dot: 'bg-iris animate-pulse', text: 'text-iris' },
  pending:     { dot: 'bg-fog-700', text: 'text-fog-400' },
  failed:      { dot: 'bg-rust',   text: 'text-rust' },
  abandoned:   { dot: 'bg-fog-700', text: 'text-fog-600 line-through' },
};

export function RetroView({ swarmRunID, retro, agentRollups, ticker }: Props) {
  if (!retro && agentRollups.length === 0) {
    return <EmptyRetro swarmRunID={swarmRunID} />;
  }

  return (
    <div className="min-h-screen bg-ink-900 text-fog-100 flex flex-col">
      <Header retro={retro} swarmRunID={swarmRunID} ticker={ticker} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[960px] py-6 px-5 space-y-6">
          {retro && <RunOverview retro={retro} />}
          {retro && retro.lessons.length > 0 && <LessonsBlock lessons={retro.lessons} />}
          {retro && retro.artifactGraph.filesFinal.length > 0 && (
            <ArtifactGraphBlock graph={retro.artifactGraph} />
          )}
          <AgentSection rollups={agentRollups} />
        </div>
      </div>
    </div>
  );
}

function Header({
  retro,
  swarmRunID,
  ticker,
}: {
  retro: RunRetro | null;
  swarmRunID: string;
  ticker?: TickerSnapshot | null;
}) {
  const tone = retro ? OUTCOME_TONE[retro.outcome] : OUTCOME_TONE.partial;
  // #7.Q40 — failure chip surfaces when the ticker stopped with a
  // failure-mode reason. Computes minute-mark from the ticker's own
  // start/stop timestamps so it survives outcome-tone churn.
  const failure = isFailureStop(ticker);
  const failureMinutes =
    failure && ticker?.stoppedAtMs && ticker?.startedAtMs
      ? fmtMinutes(ticker.stoppedAtMs - ticker.startedAtMs)
      : null;
  return (
    <header className="h-10 hairline-b bg-ink-850/80 backdrop-blur sticky top-0 z-10 flex items-center gap-3 px-4">
      <Link
        href="/"
        className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition"
      >
        ← runs
      </Link>
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">retro</span>
      <span className="font-mono text-[10.5px] tabular-nums text-fog-400 truncate">
        {swarmRunID}
      </span>
      {failure && (
        <span
          className="ml-2 inline-flex items-center gap-1.5 h-5 px-2 rounded font-mono text-[10px] uppercase tracking-widest2 bg-rust/15 text-rust border border-rust/30 shrink-0"
          title={`run stopped with failure reason: ${ticker?.stopReason ?? '(unknown)'}`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-rust" />
          {failureMinutes ? `stopped at ${failureMinutes}` : 'stopped'}
          <span className="text-rust/70">·</span>
          <span>{ticker?.stopReason}</span>
        </span>
      )}
      {retro && (
        <span className="flex items-center gap-1.5 ml-auto shrink-0">
          <span className={clsx('w-1.5 h-1.5 rounded-full', tone.dot)} />
          <span
            className={clsx(
              'font-mono text-micro uppercase tracking-widest2',
              tone.text
            )}
          >
            {retro.outcome}
          </span>
        </span>
      )}
    </header>
  );
}

function RunOverview({ retro }: { retro: RunRetro }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          run overview
        </span>
      </div>
      <div className="px-3 py-3 space-y-2">
        {retro.directive && (
          <p className="font-mono text-[11.5px] text-fog-200 leading-snug whitespace-pre-wrap">
            {retro.directive}
          </p>
        )}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10.5px]">
          <Meta label="workspace" value={retro.workspace} />
          <Meta
            label="started"
            value={fmtAbsTime(retro.timeline.start)}
          />
          <Meta
            label="ended"
            value={fmtAbsTime(retro.timeline.end)}
          />
          <Meta
            label="duration"
            value={fmtDuration(retro.timeline.durationMs)}
          />
          <Meta
            label="tokens"
            value={`${fmtTokens(retro.cost.tokensTotal)} total`}
          />
          <Meta label="cost" value={fmtCost(retro.cost.costUSD)} />
          <Meta
            label="sessions"
            value={`${retro.participants.length}`}
          />
        </dl>
      </div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="uppercase tracking-widest2 text-fog-700">{label}</dt>
      <dd className="text-fog-200 tabular-nums break-all">{value}</dd>
    </>
  );
}

function LessonsBlock({ lessons }: { lessons: RunRetro['lessons'] }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          lessons
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">
          {lessons.length}
        </span>
      </div>
      <ul className="divide-y divide-ink-800">
        {lessons.map((lesson, idx) => (
          <li
            key={idx}
            className="px-3 py-2 flex items-start gap-3"
          >
            <span
              className={clsx(
                'shrink-0 px-1.5 h-4 rounded font-mono text-[9px] uppercase tracking-widest2 border flex items-center',
                LESSON_TONE[lesson.tag] ?? 'text-fog-500 border-fog-700 bg-ink-800'
              )}
            >
              {lesson.tag}
            </span>
            <span className="font-mono text-[11.5px] text-fog-200 leading-snug flex-1 min-w-0">
              {lesson.text}
            </span>
            {lesson.evidencePartIDs.length > 0 && (
              <span
                className="font-mono text-[9.5px] text-fog-600 tabular-nums shrink-0"
                title={lesson.evidencePartIDs.join('\n')}
              >
                {lesson.evidencePartIDs.length} ref
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArtifactGraphBlock({ graph }: { graph: RunRetro['artifactGraph'] }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          artifacts
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">
          {graph.filesFinal.length} file{graph.filesFinal.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="max-h-[260px] overflow-y-auto">
        {graph.filesFinal.map((filePath) => (
          <li
            key={filePath}
            className="h-5 px-3 flex items-center hover:bg-ink-800/60 transition"
          >
            <span className="font-mono text-[11px] text-fog-200 truncate">
              {filePath}
            </span>
          </li>
        ))}
      </ul>
      {(graph.commits.length > 0 || graph.prURLs.length > 0) && (
        <div className="px-3 py-2 hairline-t flex items-center gap-4 font-mono text-[10.5px] text-fog-500">
          {graph.commits.length > 0 && <span>{graph.commits.length} commits</span>}
          {graph.prURLs.length > 0 && (
            <span className="flex items-center gap-2">
              {graph.prURLs.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-iris hover:text-iris/80 truncate max-w-[300px]"
                >
                  {url}
                </a>
              ))}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function AgentSection({ rollups }: { rollups: AgentRollup[] }) {
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

function EmptyRetro({ swarmRunID }: { swarmRunID: string }) {
  return (
    <div className="min-h-screen bg-ink-900 text-fog-100 flex flex-col">
      <header className="h-10 hairline-b bg-ink-850/80 backdrop-blur flex items-center gap-3 px-4">
        <Link
          href="/"
          className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition"
        >
          ← runs
        </Link>
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">retro</span>
        <span className="font-mono text-[10.5px] tabular-nums text-fog-400 truncate">
          {swarmRunID}
        </span>
      </header>
      <div className="flex-1 flex items-center justify-center px-6">
        <GenerateRollupCard swarmRunID={swarmRunID} />
      </div>
    </div>
  );
}

// #7.Q20 — clickable empty-state. Rollups now auto-fire at run-end, but
// runs that finished before that ship (or runs whose stop crashed) still
// land here. The button POSTs to the rollup endpoint and reloads on
// success so the user sees the retro one click later instead of needing
// the curl from the comment.
function GenerateRollupCard({ swarmRunID }: { swarmRunID: string }) {
  return (
    <div className="max-w-[520px] space-y-3 hairline rounded bg-ink-850 px-5 py-6">
      <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
        no rollup yet
      </div>
      <p className="font-mono text-[12px] text-fog-300 leading-relaxed">
        This run has no L2 rollup recorded yet. Newer runs auto-fire one at
        run-end; older runs need a manual generate. Click below to fire it
        now (~1-3s for typical runs):
      </p>
      <RollupGenerateButton swarmRunID={swarmRunID} />
      <p className="font-mono text-[10.5px] text-fog-700 pt-1">
        Or from the terminal:
      </p>
      <pre className="font-mono text-[10.5px] bg-ink-900 rounded hairline px-3 py-2 text-fog-500 overflow-x-auto">
{`curl -X POST http://localhost:3000/api/swarm/memory/rollup \\
  -H 'content-type: application/json' \\
  -d '{"swarmRunID":"${swarmRunID}"}'`}
      </pre>
    </div>
  );
}

function RollupGenerateButton({ swarmRunID }: { swarmRunID: string }) {
  // HARDENING_PLAN.md#E9 — useMutation replaces document.activeElement
  // mutation + manual error label. Pre-fix the click handler grabbed
  // the active element by side effect, mutated its disabled+textContent
  // imperatively, and reloaded the page on success. Now state is React-
  // managed and the imperative DOM mutation smell is gone.
  const rollupMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch('/api/swarm/memory/rollup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ swarmRunID }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      // Same UX as before — full reload to pick up the freshly-written
      // rollups + retro from the server. Could be improved to hit the
      // canonical TanStack queryKey once retros migrate.
      window.location.reload();
    },
  });
  const label = rollupMutation.isPending
    ? 'generating…'
    : rollupMutation.isError
      ? `error: ${(rollupMutation.error as Error)?.message ?? 'unknown'} — retry`
      : 'generate rollup';
  return (
    <button
      type="button"
      onClick={() => rollupMutation.mutate()}
      disabled={rollupMutation.isPending}
      className="w-full h-7 px-3 rounded font-mono text-[11px] uppercase tracking-widest2 cursor-pointer bg-ink-800 hairline text-fog-200 hover:border-mint/40 hover:text-mint transition disabled:cursor-wait disabled:opacity-70"
    >
      {label}
    </button>
  );
}
