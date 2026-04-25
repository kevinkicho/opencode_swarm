'use client';

// Debate rail — pattern-specific tab for `debate-judge`. Surfaces the
// generator-proposes / judge-decides loop as a row-per-round matrix:
// each generator's draft length is one column, the judge's verdict is
// another. The user gets a one-screen answer to "what did each
// generator say each round, and how did the judge call it?"
//
// Spec frozen in docs/PATTERN_DESIGN/debate-judge.md §3.
//
// Slot layout (per debate-judge kickoff in lib/server/debate-judge.ts):
//   slots[0]   = judge   (agent='judge')
//   slots[1..] = generators (agent='generator-1', 'generator-2', …)
// Same defensive identification-by-agent-name pattern as iterations-rail.

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';

interface RoundCell {
  // Length in lines of the generator's proposal that round; null when
  // the generator hasn't produced anything yet for that round.
  lines: number | null;
  // For round ≥ 2, a diff signal vs prior round. null on R1 / no prior.
  diff: string | null;
  status: 'pending' | 'drafting' | 'completed' | 'errored';
}

interface RoundRow {
  round: number; // 1-indexed
  generators: RoundCell[];
  judge: {
    verdict: 'winner' | 'merge' | 'revise' | 'pending' | 'unknown';
    target: number | null; // for WINNER:N — which generator index (0-based)
    text: string | null; // first ~80 chars of judge text after the keyword
    completed: boolean;
  };
  status: 'pending' | 'deliberating' | 'done';
}

function turnText(m: OpencodeMessage): string {
  let out = '';
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') {
      out += (p as { text?: string }).text ?? '';
    }
  }
  return out;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

function diffSummary(prev: string, next: string): string {
  if (!prev && !next) return '';
  const prevSet = new Set(prev.split('\n').map((l) => l.trim()).filter(Boolean));
  const nextSet = new Set(next.split('\n').map((l) => l.trim()).filter(Boolean));
  let added = 0;
  let removed = 0;
  for (const l of nextSet) if (!prevSet.has(l)) added += 1;
  for (const l of prevSet) if (!nextSet.has(l)) removed += 1;
  if (added === 0 && removed === 0) return 'no change';
  return `+${added} / -${removed}`;
}

// Parse judge verdict + target from review text. Convention from
// buildJudgePrompt: WINNER:<N> / MERGE:<text> / REVISE:<feedback>.
// Lenient on case + colon-vs-space.
function parseVerdict(text: string): {
  verdict: 'winner' | 'merge' | 'revise' | 'unknown';
  target: number | null;
  body: string;
} {
  if (!text) return { verdict: 'unknown', target: null, body: '' };
  const trimmed = text.trimStart();
  const head = trimmed.slice(0, 40).toUpperCase();
  if (head.startsWith('WINNER')) {
    const m = /^WINNER\s*[:\s]\s*(\d+)/i.exec(trimmed);
    const target = m ? parseInt(m[1] ?? '0', 10) - 1 : null; // user-facing 1-indexed → 0-indexed
    return {
      verdict: 'winner',
      target,
      body: trimmed.replace(/^WINNER\s*[:\s]\s*\d+\s*/i, '').slice(0, 80),
    };
  }
  if (head.startsWith('MERGE')) {
    return {
      verdict: 'merge',
      target: null,
      body: trimmed.replace(/^MERGE\s*[:\s]\s*/i, '').slice(0, 80),
    };
  }
  if (head.startsWith('REVISE')) {
    return {
      verdict: 'revise',
      target: null,
      body: trimmed.replace(/^REVISE\s*[:\s]\s*/i, '').slice(0, 80),
    };
  }
  return { verdict: 'unknown', target: null, body: trimmed.slice(0, 80) };
}

// Identify judge + generators from slots. judge has agent='judge';
// generators have 'generator-N' or just 'generator'. Falls back to
// slot-order: slot[0]=judge, slot[1..]=generators.
function classifySlots(slots: LiveSwarmSessionSlot[]): {
  judge: LiveSwarmSessionSlot | null;
  generators: LiveSwarmSessionSlot[];
} {
  let judge: LiveSwarmSessionSlot | null = null;
  const generators: LiveSwarmSessionSlot[] = [];
  for (const s of slots) {
    const firstAssist = s.messages.find((m) => m.info.role === 'assistant');
    const agent = firstAssist?.info.agent ?? '';
    if (agent === 'judge') judge = judge ?? s;
    else if (agent.startsWith('generator')) generators.push(s);
  }
  // Fallback: slot order.
  if (!judge && slots.length > 0) judge = slots[0];
  if (generators.length === 0 && slots.length > 1) {
    for (let i = 1; i < slots.length; i += 1) generators.push(slots[i]);
  }
  return { judge, generators };
}

export function DebateRail({
  slots,
  embedded = false,
}: {
  slots: LiveSwarmSessionSlot[];
  embedded?: boolean;
}) {
  const { judge, generators, rows } = useMemo(() => {
    const { judge, generators } = classifySlots(slots);

    // Each generator's assistant messages, in order. The Nth assistant
    // message corresponds to round N+1. Judge's Nth assistant message
    // is the verdict on round N+1's proposals.
    const generatorDrafts: OpencodeMessage[][] = generators.map((g) =>
      g.messages.filter((m) => m.info.role === 'assistant'),
    );
    const judgeVerdicts = (judge?.messages ?? []).filter(
      (m) => m.info.role === 'assistant',
    );

    const maxRound = Math.max(
      ...generatorDrafts.map((d) => d.length),
      judgeVerdicts.length,
      0,
    );

    const rows: RoundRow[] = [];
    for (let r = 0; r < maxRound; r += 1) {
      const cells: RoundCell[] = generators.map((_, gi) => {
        const draft = generatorDrafts[gi]?.[r];
        if (!draft) {
          return { lines: null, diff: null, status: 'pending' };
        }
        const text = turnText(draft);
        const lines = countLines(text);
        let diff: string | null = null;
        if (r > 0 && generatorDrafts[gi][r - 1]) {
          const prev = turnText(generatorDrafts[gi][r - 1]);
          diff = diffSummary(prev, text);
        }
        const status: RoundCell['status'] = draft.info.error
          ? 'errored'
          : draft.info.time.completed
            ? 'completed'
            : 'drafting';
        return { lines, diff, status };
      });

      const verdictMsg = judgeVerdicts[r];
      const verdict = verdictMsg ? parseVerdict(turnText(verdictMsg)) : null;
      const judgeStatus: RoundCell['status'] = !verdictMsg
        ? 'pending'
        : verdictMsg.info.time.completed
          ? 'completed'
          : 'drafting';

      // Round status: done if judge has a non-revise terminal verdict;
      // deliberating if judge is generating; pending otherwise.
      const allGenDone = cells.every((c) => c.status === 'completed');
      const rowStatus: RoundRow['status'] =
        verdict && (verdict.verdict === 'winner' || verdict.verdict === 'merge')
          ? 'done'
          : verdict && verdict.verdict === 'revise'
            ? 'done' // round itself complete; loop continues to next
            : judgeStatus === 'drafting' || allGenDone
              ? 'deliberating'
              : 'pending';

      rows.push({
        round: r + 1,
        generators: cells,
        judge: {
          verdict: verdict?.verdict ?? (judgeStatus === 'pending' ? 'pending' : 'unknown'),
          target: verdict?.target ?? null,
          text: verdict?.body ?? null,
          completed: judgeStatus === 'completed',
        },
        status: rowStatus,
      });
    }

    return { judge, generators, rows };
  }, [slots]);

  // Final verdict pin: any WINNER / MERGE in the rows.
  const final = rows.find(
    (r) => r.judge.verdict === 'winner' || r.judge.verdict === 'merge',
  );
  const headerStatus = final
    ? `final ${final.judge.verdict.toUpperCase()} at R${final.round}`
    : rows.length === 0
      ? 'awaiting first round'
      : `R${rows.length}/${rows.length}`;

  if (rows.length === 0 || !judge || generators.length === 0) {
    return wrap(
      embedded,
      headerStatus,
      !!final,
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        awaiting first round — {generators.length} of N generators drafting
      </div>,
    );
  }

  return wrap(
    embedded,
    headerStatus,
    !!final,
    <DebateListBody
      rows={rows}
      generatorCount={generators.length}
      finalRound={final?.round ?? null}
    />,
  );
}

function wrap(
  embedded: boolean,
  headerStatus: string,
  hasFinal: boolean,
  body: React.ReactNode,
) {
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        debate
      </span>
      <span
        className={clsx(
          'font-mono text-micro tabular-nums',
          hasFinal ? 'text-mint' : 'text-fog-700',
        )}
      >
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

const VERDICT_TONE: Record<RoundRow['judge']['verdict'], string> = {
  winner: 'text-mint',
  merge: 'text-iris',
  revise: 'text-amber',
  pending: 'text-fog-700',
  unknown: 'text-fog-500',
};

const VERDICT_LABEL: Record<RoundRow['judge']['verdict'], string> = {
  winner: 'WINNER',
  merge: 'MERGE',
  revise: 'REVISE',
  pending: '—',
  unknown: '?',
};

const STATUS_TONE: Record<RoundRow['status'], string> = {
  pending: 'text-fog-700',
  deliberating: 'text-iris animate-pulse',
  done: 'text-fog-500',
};

function compactNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function DebateRowEl({
  row,
  generatorCount,
  isFinal,
}: {
  row: RoundRow;
  generatorCount: number;
  isFinal: boolean;
}) {
  // Cap visible generator columns at 4 for layout; collapse extras into
  // a "+N more" chip. Most debate runs are 2-4 generators per the
  // SWARM_PATTERNS.md guidance.
  const visibleGens = row.generators.slice(0, 4);
  const overflowGens = row.generators.length - visibleGens.length;

  // grid: round 24 · gen × visibleN (~64px each) · judge flex · status 56
  const gridCols = `24px repeat(${visibleGens.length}, 64px)${overflowGens > 0 ? ' 32px' : ''} minmax(0, 1fr) 56px`;

  return (
    <li
      className={clsx(
        'h-6 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition',
        isFinal && 'bg-mint/[0.06]',
      )}
      style={{ gridTemplateColumns: gridCols }}
      title={row.judge.text ?? undefined}
    >
      <span className="text-fog-400 tabular-nums">R{row.round}</span>
      {visibleGens.map((cell, gi) => (
        <span
          key={gi}
          className={clsx(
            'tabular-nums text-[9px]',
            cell.status === 'pending'
              ? 'text-fog-800'
              : cell.status === 'errored'
                ? 'text-rust'
                : cell.status === 'drafting'
                  ? 'text-fog-300 animate-pulse'
                  : 'text-fog-400',
          )}
          title={
            cell.diff
              ? `R${row.round} draft from generator ${gi + 1} · ${cell.lines}L · ${cell.diff} vs prior round`
              : cell.lines !== null
                ? `R${row.round} draft from generator ${gi + 1} · ${cell.lines}L`
                : 'pending'
          }
        >
          {cell.lines !== null ? `${compactNum(cell.lines)}L` : '—'}
          {cell.diff && cell.diff !== 'no change' && (
            <span className="ml-1 text-fog-700 text-[8px]">{cell.diff}</span>
          )}
        </span>
      ))}
      {overflowGens > 0 && (
        <span
          className="font-mono text-[9px] text-fog-700 text-center"
          title={`+${overflowGens} more generator${overflowGens === 1 ? '' : 's'}`}
        >
          +{overflowGens}
        </span>
      )}
      <span className="truncate min-w-0 flex items-center gap-1.5">
        <span
          className={clsx(
            'uppercase tracking-widest2 text-[9px] shrink-0',
            VERDICT_TONE[row.judge.verdict],
          )}
        >
          {VERDICT_LABEL[row.judge.verdict]}
          {row.judge.target !== null && (
            <span className="ml-1 text-fog-500 normal-case tracking-normal">
              → g{row.judge.target + 1}
            </span>
          )}
        </span>
        {row.judge.text && (
          <span className="text-fog-500 truncate text-[9.5px] min-w-0">
            {row.judge.text}
          </span>
        )}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px] text-right',
          STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
    </li>
  );
}

// Stick-to-bottom-enabled body — IMPLEMENTATION_PLAN 6.7 + 6.8.
function DebateListBody({
  rows,
  generatorCount,
  finalRound,
}: {
  rows: RoundRow[];
  generatorCount: number;
  finalRound: number | null;
}) {
  const scrollRef = useRef<HTMLUListElement>(null);
  useStickToBottom(scrollRef, rows.length);
  return (
    <>
      <ul
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none min-h-0"
      >
        {rows.map((row) => (
          <DebateRowEl
            key={row.round}
            row={row}
            generatorCount={generatorCount}
            isFinal={finalRound === row.round}
          />
        ))}
      </ul>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </>
  );
}
