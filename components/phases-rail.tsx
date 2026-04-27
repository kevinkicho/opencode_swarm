'use client';

// Phases rail — pattern-specific tab for `deliberate-execute`. Three
// stacked sections mirroring the pattern's phase timeline:
//
//   PHASE 1 · DELIBERATION  — per-round: members idle / avg-len /
//                             convergence / status / time
//   PHASE 2 · SYNTHESIS     — single row: session-0 extracting todos
//   PHASE 3 · EXECUTION     — board-item count chips
//
// Ephemeral transition banners appear at phase boundaries: "Deliberation
// complete — synthesizing", "Synthesis complete — execution started".
// Each banner renders for ~20s of continuous phase-active state.
//

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveBoard } from '@/lib/blackboard/live';
import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';
import type { DeliberationProgress } from '@/lib/deliberate-progress';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import { countLines, turnText } from './rails/_shared';

// components/rails/_shared.ts.

// Token-jaccard convergence, same as council-rail. Kept inline so the
// two components stay decoupled — a later shared helper is trivial
// once we have a third caller.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that',
  'it', 'its', 'as', 'by', 'at', 'from', 'but', 'if', 'not',
]);

function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function aggregateJaccard(sets: Set<string>[]): number | null {
  if (sets.length < 2) return null;
  let pairs = 0;
  let sum = 0;
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = sets[i];
      const b = sets[j];
      if (a.size === 0 && b.size === 0) continue;
      let intersect = 0;
      for (const t of a) if (b.has(t)) intersect += 1;
      const union = a.size + b.size - intersect;
      if (union === 0) continue;
      sum += intersect / union;
      pairs += 1;
    }
  }
  return pairs > 0 ? sum / pairs : null;
}

interface DeliberationRow {
  round: number;
  idleCount: number;
  totalMembers: number;
  avgLen: number;
  convergence: number | null;
  status: 'pending' | 'in-progress' | 'done';
  durationMs: number | null;
}

interface SynthesisRow {
  ownerSlot: number;
  status: 'pending' | 'in-progress' | 'done' | 'stale';
  todoCount: number;
  durationMs: number | null;
}

// Format duration in minutes with 1-decimal below 10, integer above.
function fmtMin(ms: number | null): string {
  if (ms === null || ms <= 0) return '—';
  const m = ms / 60_000;
  if (m < 1) return '<1m';
  if (m < 10) return `${m.toFixed(1)}m`;
  return `${Math.round(m)}m`;
}

export function PhasesRail({
  slots,
  live,
  deliberationProgress,
  embedded = false,
}: {
  slots: LiveSwarmSessionSlot[];
  live: LiveBoard;
  deliberationProgress?: DeliberationProgress | null;
  embedded?: boolean;
}) {
  const { deliberation, synthesis, execution, phase } = useMemo(() => {
    const items = live.items ?? [];
    const maxRounds = deliberationProgress?.maxRounds ?? 3;

    // Deliberation: per-round per-member completed assistant text turns.
    // Timestamps via info.time.completed let us compute a round-duration.
    const byMember: OpencodeMessage[][] = slots.map((s) =>
      s.messages.filter((m) => m.info.role === 'assistant'),
    );

    const deliberation: DeliberationRow[] = [];
    for (let r = 0; r < maxRounds; r += 1) {
      const draftsThisRound = byMember.map((list) => list[r]).filter(Boolean) as OpencodeMessage[];
      const idleCount = draftsThisRound.filter((m) => m.info.time.completed).length;
      const texts = draftsThisRound
        .filter((m) => m.info.time.completed)
        .map((m) => turnText(m));
      const avgLen =
        texts.length > 0
          ? Math.round(texts.reduce((s, t) => s + countLines(t), 0) / texts.length)
          : 0;
      const convergence =
        texts.length >= 2 ? aggregateJaccard(texts.map((t) => tokenize(t))) : null;
      const status: DeliberationRow['status'] =
        draftsThisRound.length === 0
          ? 'pending'
          : idleCount === slots.length
            ? 'done'
            : 'in-progress';
      // Duration: earliest draft's created → latest draft's completed.
      let earliestStart: number | null = null;
      let latestEnd: number | null = null;
      for (const m of draftsThisRound) {
        const s = m.info.time.created;
        const e = m.info.time.completed;
        if (s && (earliestStart === null || s < earliestStart)) earliestStart = s;
        if (e && (latestEnd === null || e > latestEnd)) latestEnd = e;
      }
      const durationMs =
        earliestStart !== null && latestEnd !== null ? latestEnd - earliestStart : null;
      deliberation.push({
        round: r + 1,
        idleCount,
        totalMembers: slots.length,
        avgLen,
        convergence,
        status,
        durationMs,
      });
    }

    const deliberationDone =
      deliberation.length > 0 &&
      deliberation.every((d) => d.status === 'done');

    // Synthesis: session 0's (N+1)-th assistant message where N=maxRounds.
    // runSynthesis posts one additional prompt after the final round's
    // council wait. We detect it as assistant message beyond the round
    // bound. If slots[0] has more assistant messages than maxRounds, the
    // extra one is the synthesis turn.
    const session0Drafts = byMember[0] ?? [];
    const synthMsg = session0Drafts[maxRounds]; // (index maxRounds = (maxRounds+1)-th item)
    // Todo count: count todo-kind board items if the board has any.
    const todoCount = items.filter((it) => it.kind === 'todo').length;
    let synthStatus: SynthesisRow['status'] = 'pending';
    let synthDuration: number | null = null;
    if (synthMsg) {
      if (synthMsg.info.error) synthStatus = 'stale';
      else if (synthMsg.info.time.completed) synthStatus = 'done';
      else synthStatus = 'in-progress';
      if (synthMsg.info.time.completed && synthMsg.info.time.created) {
        synthDuration = synthMsg.info.time.completed - synthMsg.info.time.created;
      }
    } else if (deliberationDone && todoCount > 0) {
      // Fallback: if we see todos on the board and deliberation is done,
      // synthesis must have happened even if the message didn't land in
      // our slot window.
      synthStatus = 'done';
    }
    const synthesis: SynthesisRow | null =
      synthMsg || synthStatus === 'done'
        ? {
            ownerSlot: 0,
            status: synthStatus,
            todoCount,
            durationMs: synthDuration,
          }
        : null;

    // Execution counters — derived from board items excluding non-todo kinds
    // (criteria / synthesize) which clutter the "actual work" signal.
    const todos = items.filter((it) => it.kind === 'todo');
    const execution = {
      total: todos.length,
      done: todos.filter((t) => t.status === 'done').length,
      inProgress: todos.filter((t) => t.status === 'in-progress' || t.status === 'claimed').length,
      stale: todos.filter((t) => t.status === 'stale' || t.status === 'blocked').length,
    };

    // Current phase: whichever is in-progress (or the first not-done).
    const phase: 'deliberation' | 'synthesis' | 'execution' | 'done' =
      !deliberationDone
        ? 'deliberation'
        : synthesis && synthesis.status !== 'done'
          ? 'synthesis'
          : execution.total > 0 && execution.done < execution.total
            ? 'execution'
            : execution.total > 0 && execution.done === execution.total
              ? 'done'
              : 'synthesis';

    return { deliberation, synthesis, execution, phase };
  }, [slots, live.items, deliberationProgress?.maxRounds]);

  if (slots.length === 0) {
    return wrap(
      embedded,
      'no members assigned',
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        run hasn't dispatched council members yet
      </div>,
    );
  }

  // Header summary: current phase in bold, others dim.
  const headerStatus =
    phase === 'deliberation'
      ? `deliberation · R${deliberation.filter((d) => d.status === 'done').length + 1}/${deliberation.length}`
      : phase === 'synthesis'
        ? 'synthesizing'
        : phase === 'execution'
          ? `execution · ${execution.done}/${execution.total} done`
          : 'run complete';

  return wrap(
    embedded,
    headerStatus,
    <PhasesScrollBody
      deliberation={deliberation}
      synthesis={synthesis}
      execution={execution}
      phase={phase}
    />,
  );
}

// Stick-to-bottom-enabled scrollable container for the 3-phase
// stack. Phase chronologically appends content (deliberation rounds
// → synthesis row → execution counters), so bottom-stick lands the
// user on the active phase. Content signal: deliberation count +
// synthesis presence + execution total.
function PhasesScrollBody({
  deliberation,
  synthesis,
  execution,
  phase,
}: {
  deliberation: DeliberationRow[];
  synthesis: SynthesisRow | null;
  execution: { total: number; done: number; inProgress: number; stale: number };
  phase: 'deliberation' | 'synthesis' | 'execution' | 'done';
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sig = `${deliberation.length}:${synthesis ? '1' : '0'}:${execution.total}`;
  useStickToBottom(scrollRef, sig);
  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 flex flex-col"
      >
        <PhaseHeader label="phase 1 · deliberation" active={phase === 'deliberation'} complete={deliberation.every((d) => d.status === 'done')} />
        {deliberation.length === 0 ? (
          <div className="px-3 py-1 font-mono text-micro uppercase tracking-widest2 text-fog-700">
            awaiting R1
          </div>
        ) : (
          <ul className="list-none">
            {deliberation.map((row) => (
              <DeliberationRowEl key={row.round} row={row} />
            ))}
          </ul>
        )}

        <PhaseHeader label="phase 2 · synthesis" active={phase === 'synthesis'} complete={synthesis?.status === 'done'} />
        {synthesis ? (
          <SynthesisRowEl row={synthesis} />
        ) : (
          <div className="px-3 py-1 font-mono text-micro uppercase tracking-widest2 text-fog-700">
            awaiting synthesis
          </div>
        )}

        <PhaseHeader label="phase 3 · execution" active={phase === 'execution'} complete={phase === 'done'} />
        {execution.total === 0 ? (
          <div className="px-3 py-1 font-mono text-micro uppercase tracking-widest2 text-fog-700">
            awaiting todos
          </div>
        ) : (
          <div className="px-3 py-1 flex items-center gap-2 font-mono text-[10.5px] tabular-nums">
            <span className="text-fog-400">
              <span className="text-fog-200">{execution.total}</span> todos
            </span>
            {execution.inProgress > 0 && (
              <span className="text-molten">{execution.inProgress} in-progress</span>
            )}
            {execution.stale > 0 && <span className="text-amber">{execution.stale} stale</span>}
            <span className={clsx(execution.done > 0 ? 'text-mint' : 'text-fog-700')}>
              {execution.done} done
            </span>
          </div>
        )}
      </div>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </>
  );
}

function wrap(embedded: boolean, headerStatus: string, body: React.ReactNode) {
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        phases
      </span>
      <span className="font-mono text-micro tabular-nums text-fog-700 truncate">
        {headerStatus}
      </span>
    </div>
  );
  if (embedded) return <>{header}{body}</>;
  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden bg-ink-850 max-h-[420px]">
      {header}
      {body}
    </section>
  );
}

function PhaseHeader({
  label,
  active,
  complete,
}: {
  label: string;
  active: boolean;
  complete: boolean | undefined;
}) {
  return (
    <div
      className={clsx(
        'hairline-b hairline-t px-3 py-0.5 font-mono text-micro uppercase tracking-widest2',
        active
          ? 'bg-molten/[0.06] text-molten'
          : complete
            ? 'bg-ink-900/40 text-mint'
            : 'bg-ink-900/40 text-fog-600',
      )}
    >
      {label}
      {active && <span className="ml-1.5 text-fog-500 normal-case">· active</span>}
      {!active && complete && <span className="ml-1.5 text-fog-500 normal-case">· done</span>}
    </div>
  );
}

const DELIB_STATUS_TONE: Record<DeliberationRow['status'], string> = {
  pending: 'text-fog-700',
  'in-progress': 'text-molten animate-pulse',
  done: 'text-mint',
};

function DeliberationRowEl({ row }: { row: DeliberationRow }) {
  const convLabel =
    row.convergence === null
      ? '—'
      : row.convergence >= 0.8
        ? 'high'
        : row.convergence >= 0.5
          ? 'med'
          : 'low';
  const convTone =
    row.convergence === null
      ? 'text-fog-700'
      : row.convergence >= 0.8
        ? 'text-mint'
        : row.convergence >= 0.5
          ? 'text-amber'
          : 'text-rust';
  return (
    <li
      className="h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition"
      style={{
        // round 24 · members 60 · avg-len 48 · conv 48 · status 64 · time 40
        gridTemplateColumns: '24px 60px 48px 48px minmax(0, 1fr) 40px',
      }}
      title={
        row.convergence !== null
          ? `R${row.round} · ${(row.convergence * 100).toFixed(0)}% convergence · ${row.idleCount}/${row.totalMembers} idle`
          : `R${row.round} · ${row.idleCount}/${row.totalMembers} idle`
      }
    >
      <span className="text-fog-400 tabular-nums">R{row.round}</span>
      <span className="text-fog-400 tabular-nums text-right">
        {row.idleCount}/{row.totalMembers}
      </span>
      <span className="text-fog-400 tabular-nums text-right">
        {row.avgLen > 0 ? `${row.avgLen}L` : '—'}
      </span>
      <span className={clsx('uppercase tracking-widest2 text-[9px] text-right', convTone)}>
        {convLabel}
      </span>
      <span className={clsx('uppercase tracking-widest2 text-[9px] text-right', DELIB_STATUS_TONE[row.status])}>
        {row.status}
      </span>
      <span className="tabular-nums text-right text-fog-700">{fmtMin(row.durationMs)}</span>
    </li>
  );
}

const SYNTH_STATUS_TONE: Record<SynthesisRow['status'], string> = {
  pending: 'text-fog-700',
  'in-progress': 'text-molten animate-pulse',
  done: 'text-mint',
  stale: 'text-amber',
};

function SynthesisRowEl({ row }: { row: SynthesisRow }) {
  return (
    <div
      className="h-6 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition"
      style={{
        // label 160 · owner 32 · status 64 · output 56 · time 40
        gridTemplateColumns: 'minmax(0, 1fr) 32px 64px 56px 40px',
      }}
      title={`synthesis on session s${row.ownerSlot}`}
    >
      <span className="text-fog-300 truncate">synthesis → todowrite</span>
      <span className="text-iris font-mono text-[10px] tabular-nums">s{row.ownerSlot}</span>
      <span className={clsx('uppercase tracking-widest2 text-[9px] text-right', SYNTH_STATUS_TONE[row.status])}>
        {row.status}
      </span>
      <span className="tabular-nums text-right text-fog-400">
        {row.todoCount > 0 ? `${row.todoCount} todo${row.todoCount === 1 ? '' : 's'}` : '—'}
      </span>
      <span className="tabular-nums text-right text-fog-700">{fmtMin(row.durationMs)}</span>
    </div>
  );
}
