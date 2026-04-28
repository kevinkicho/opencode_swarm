'use client';

// Debate rail — pattern-specific tab for `debate-judge`. Surfaces the
// generator-proposes / judge-decides loop as a row-per-round matrix:
// each generator's draft length is one column, the judge's verdict is
// another. The user gets a one-screen answer to "what did each
// generator say each round, and how did the judge call it?"
//
// Slot layout (per debate-judge kickoff in lib/server/debate-judge.ts):
//   slots[0]   = judge   (agent='judge')
//   slots[1..] = generators (agent='generator-1', 'generator-2', …)
// Same defensive identification-by-agent-name pattern as iterations-rail.
//
// 2026-04-28 decomposition: pure parser + classifier + types →
// debate-rail/helpers.ts; DebateRowEl per-round renderer →
// debate-rail/row.tsx. This file holds the rail composition.

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import { countLines, turnText } from './rails/_shared';
import {
  type RoundCell,
  type RoundRow,
  classifySlots,
  diffSummary,
  parseVerdict,
} from './debate-rail/helpers';
import { DebateRowEl } from './debate-rail/row';

export function DebateRail({
  slots,
  embedded = false,
  // Accepted but not wired in v1 — debate rows are rounds, not sessions,
  // so inspector wiring needs cell-level (per-generator / judge) clicks
  // which require restructuring the row component. Page passes this so
  // a future cell-level enhancement is non-breaking.
  // 6.9 v2.
  onInspectSession: _onInspectSession,
}: {
  slots: LiveSwarmSessionSlot[];
  embedded?: boolean;
  onInspectSession?: (sessionID: string) => void;
}) {
  void _onInspectSession;
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

function DebateListBody({
  rows,
  finalRound,
}: {
  rows: RoundRow[];
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
            isFinal={finalRound === row.round}
          />
        ))}
      </ul>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </>
  );
}
