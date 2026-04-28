'use client';

// Council rail — pattern-specific tab for `council`. Every session does
// the same work each round; the tab's job is to show convergence across
// members per round so the user can spot "R2 drafts look 80% similar —
// we could stop here" long before R_max fires. Each row = one round;
// each column = one member's draft length. A trailing convergence chip
// summarizes how close the drafts are to each other.
//
// Convergence metric: pairwise token-jaccard on the last-round drafts
// (cheap, deterministic, order-invariant). >0.8 = high (mint), 0.5-0.8
// = med (amber), <0.5 = low (rust).
//
// 2026-04-28 decomposition: pure jaccard + tokenization + tone helpers
// + types → council-rail/jaccard.ts; CouncilRowEl per-round renderer →
// council-rail/row.tsx. This file holds the rail composition.

import { useMemo, useRef } from 'react';

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { countLines, turnText } from './rails/_shared';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import {
  type MemberDraft,
  type RoundRow,
  aggregateJaccard,
  diffSummary,
  pairJaccard,
  tokenize,
} from './council-rail/jaccard';
import { CouncilRowEl } from './council-rail/row';

export function CouncilRail({
  slots,
  embedded = false,
  // Accepted but not wired in v1 — council rows are rounds, not sessions,
  // so inspector wiring needs cell-level (per-member) clicks which
  // require restructuring the row component. Page passes this so a
  // future cell-level enhancement is non-breaking.
  // 6.9 v2.
  onInspectSession: _onInspectSession,
}: {
  slots: LiveSwarmSessionSlot[];
  embedded?: boolean;
  onInspectSession?: (sessionID: string) => void;
}) {
  void _onInspectSession;
  const { rows, trend } = useMemo(() => {
    if (slots.length < 2) return { rows: [] as RoundRow[], trend: null as 'up' | 'flat' | 'down' | null };

    // Each member's assistant messages in chronological order — Nth
    // message = Nth round. Council has all members seeded identically
    // so slot order is the natural member order.
    const byMember: OpencodeMessage[][] = slots.map((s) =>
      s.messages.filter((m) => m.info.role === 'assistant'),
    );
    const maxRounds = Math.max(...byMember.map((m) => m.length), 0);

    const rows: RoundRow[] = [];
    for (let r = 0; r < maxRounds; r += 1) {
      const members: MemberDraft[] = byMember.map((memberDrafts) => {
        const msg = memberDrafts[r];
        if (!msg) {
          return {
            lines: 0,
            text: '',
            diffVsPrior: null,
            status: 'pending',
            selfJaccard: null,
          };
        }
        const text = turnText(msg);
        const lines = countLines(text);
        const prior = r > 0 ? memberDrafts[r - 1] : null;
        const priorText = prior ? turnText(prior) : '';
        const diffVsPrior = prior ? diffSummary(priorText, text) : null;
        const status: MemberDraft['status'] = msg.info.error
          ? 'errored'
          : msg.info.time.completed
            ? 'completed'
            : 'drafting';
        // Self-jaccard only meaningful when both rounds completed
        // and both have content. Pending/drafting members get null.
        let selfJaccard: number | null = null;
        if (
          prior &&
          status === 'completed' &&
          prior.info.time.completed &&
          priorText &&
          text
        ) {
          selfJaccard = pairJaccard(tokenize(priorText), tokenize(text));
        }
        return { lines, text, diffVsPrior, status, selfJaccard };
      });

      const completedTexts = members
        .filter((m) => m.status === 'completed' && m.text)
        .map((m) => tokenize(m.text));
      const convergence = aggregateJaccard(completedTexts);

      const completedCount = members.filter((m) => m.status === 'completed').length;
      const draftingCount = members.filter((m) => m.status === 'drafting').length;
      const status: RoundRow['status'] =
        completedCount === members.length
          ? 'done'
          : draftingCount > 0
            ? 'in-progress'
            : 'pending';

      rows.push({ round: r + 1, members, convergence, status });
    }

    // Trend: compare the last two rounds' convergence values. Up if
    // growing, down if shrinking, flat within 0.05 tolerance.
    let trend: 'up' | 'flat' | 'down' | null = null;
    if (rows.length >= 2) {
      const a = rows[rows.length - 2].convergence;
      const b = rows[rows.length - 1].convergence;
      if (a !== null && b !== null) {
        const delta = b - a;
        trend = Math.abs(delta) < 0.05 ? 'flat' : delta > 0 ? 'up' : 'down';
      }
    }

    return { rows, trend };
  }, [slots]);

  const headerStatus =
    rows.length === 0
      ? slots.length > 0
        ? `R1 in progress — 0 of ${slots.length} members drafting`
        : 'no members assigned yet'
      : `R${rows.length}/${rows.length}${trend ? ` · convergence ${trend}` : ''}`;

  if (rows.length === 0) {
    return wrap(
      embedded,
      headerStatus,
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        waiting for first round drafts — {slots.length} member
        {slots.length === 1 ? '' : 's'} assigned
      </div>,
    );
  }

  return wrap(
    embedded,
    headerStatus,
    <CouncilListBody rows={rows} memberCount={slots.length} />,
  );
}

function CouncilListBody({
  rows,
  memberCount,
}: {
  rows: RoundRow[];
  memberCount: number;
}) {
  const scrollRef = useRef<HTMLUListElement>(null);
  useStickToBottom(scrollRef, rows.length);
  return (
    <>
      <ul
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none min-h-0"
      >
        {rows.map((r) => (
          <CouncilRowEl key={r.round} row={r} memberCount={memberCount} />
        ))}
      </ul>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </>
  );
}

function wrap(
  embedded: boolean,
  headerStatus: string,
  body: React.ReactNode,
) {
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        council
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
