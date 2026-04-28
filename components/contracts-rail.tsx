'use client';

// Contracts rail — pattern-specific tab for blackboard runs (and any
// hierarchical pattern that pins an auditor / critic / verifier role).
// Surfaces the verdict-shape signals that the regular `board` tab
// buries: criterion auditor verdicts, critic-rejection notes, verifier
// pass/fail, CAS drift, retry counter — all in one scannable column
// per kind so the user can answer "what's actually contractually
// settled vs still in flight?" without reading every row's tooltip.
//
// Aesthetic: dense h-5 rows, monospace, tabular-nums, ink/fog/molten/
// mint/iris/amber palette only, micro-labels (10px uppercase
// tracking-widest2) on chips. Rust used sparingly — only on terminal
// failures (CRITIC busywork, VERIFIER fail, AUDIT unmet, RETRY 2).
//
// 2026-04-28 decomposition: NoteSignals + parseNote + ranks +
// deriveCounts → contracts-rail/note-parser.ts; ContractRow →
// contracts-rail/row.tsx. This file now reads as the rail
// composition + sticky header chips.

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveBoard } from '@/lib/blackboard/live';
import type { BoardItem } from '@/lib/blackboard/types';
import { Tooltip } from './ui/tooltip';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';
import {
  TONE,
  STATUS_RANK,
  VERDICT_RANK,
  parseNote,
  deriveCounts,
  type HeaderCounts,
} from './contracts-rail/note-parser';
import { ContractRow } from './contracts-rail/row';

export function ContractsRail({
  live,
  embedded = false,
  loading = false,
}: {
  live: LiveBoard;
  embedded?: boolean;
  // True while the board snapshot is still in flight. Distinguishes
  // "board hasn't started yet" from "still loading the board" — the
  // user-visible difference between these on a cold load is huge.
  loading?: boolean;
}) {
  const items = live.items ?? [];
  const counts = useMemo(() => deriveCounts(items), [items]);
  const boardLoading = loading || (live.items === null && !live.error);

  // Sort items per spec. Don't mutate the source array.
  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const sa = STATUS_RANK[a.status] ?? 9;
      const sb = STATUS_RANK[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      // Within open: retry count desc (stuck rises), then oldest first.
      if (a.status === 'open' && b.status === 'open') {
        const ra = parseNote(a.note).retryCount;
        const rb = parseNote(b.note).retryCount;
        if (ra !== rb) return rb - ra;
      }
      // Criterion verdicts: unmet > unclear > wont-do > met
      if (a.kind === 'criterion' && b.kind === 'criterion') {
        const va = parseNote(a.note).auditVerdict;
        const vb = parseNote(b.note).auditVerdict;
        const ra = va ? VERDICT_RANK[va] : 99;
        const rb = vb ? VERDICT_RANK[vb] : 99;
        if (ra !== rb) return ra - rb;
      }
      return a.createdAtMs - b.createdAtMs;
    });
    return copy;
  }, [items]);

  // Empty-state copy depends on whether ANY criteria exist. Three cases:
  // (a) loading — show pulse so cold-load doesn't read as broken
  // (b) board has items but no criteria → "no contracts yet — planner
  //     hasn't seeded criteria"
  // (c) board is entirely empty → "board hasn't started yet"
  if (items.length === 0) {
    return wrap(
      embedded,
      <div
        className={clsx(
          'px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700',
          boardLoading && 'animate-pulse',
        )}
      >
        {boardLoading ? 'loading contracts…' : "board hasn't started yet"}
      </div>,
      counts,
    );
  }
  if (counts.criteria === 0 && counts.busywork === 0 && counts.drift === 0) {
    return wrap(
      embedded,
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        no contracts yet — planner hasn't seeded criteria, no critic /
        verifier / auditor verdicts on the board
      </div>,
      counts,
    );
  }

  return wrap(
    embedded,
    <ContractsListBody items={sorted} />,
    counts,
  );
}

// Extracted body so we can colocate the scroll-ref + stick-to-bottom
// hook + the floating "latest" button. The body is what the wrap
// helper injects between the header and (optionally) the section
// chrome — it's the scrollable list itself.
function ContractsListBody({ items }: { items: BoardItem[] }) {
  const scrollRef = useRef<HTMLUListElement>(null);
  useStickToBottom(scrollRef, items.length);
  return (
    <>
      <ul
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none min-h-0"
      >
        {items.map((item) => (
          <ContractRow key={item.id} item={item} />
        ))}
      </ul>
      <ScrollToBottomButton scrollRef={scrollRef} />
    </>
  );
}

// Wrap is a tiny helper that adds the sticky header chips above the
// body. Embedded mode (rendered inside LeftTabs) gets no outer
// section / no min-height; standalone mode gets the same chrome the
// other rails use.
function wrap(embedded: boolean, body: React.ReactNode, counts: HeaderCounts) {
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        contracts
      </span>
      <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden font-mono text-micro tabular-nums">
        {/* Sticky chips. Each is `<value> <label>` pair. Tone follows
            the row palette: mint = met (good), rust = unmet (bad),
            amber = drift / busywork (warning), fog = neutral.
            Hidden when the count is 0 to avoid eye-rolling at a row
            of dashes. */}
        {counts.criteria > 0 && (
          <Chip
            tone="mint"
            value={`${counts.met}/${counts.criteria}`}
            label="met"
            tooltip={`${counts.met} of ${counts.criteria} criteria audited as met`}
          />
        )}
        {counts.unmet > 0 && (
          <Chip
            tone="rust"
            value={String(counts.unmet)}
            label="unmet"
            tooltip={`${counts.unmet} criteria audited as not yet satisfied`}
          />
        )}
        {counts.stale > 0 && (
          <Chip
            tone="amber"
            value={String(counts.stale)}
            label="stale"
            tooltip={`${counts.stale} items in stale state — retry-exhausted or CAS-drifted`}
          />
        )}
        {counts.busywork > 0 && (
          <Chip
            tone="rust"
            value={String(counts.busywork)}
            label="busy"
            tooltip={`${counts.busywork} items rejected by the anti-busywork critic`}
          />
        )}
        {counts.drift > 0 && (
          <Chip
            tone="amber"
            value={String(counts.drift)}
            label="drift"
            tooltip={`${counts.drift} items hit CAS drift on commit (file moved under worker)`}
          />
        )}
      </div>
    </div>
  );

  if (embedded) {
    return (
      <>
        {header}
        {body}
      </>
    );
  }
  return (
    <section className="relative flex flex-col min-w-0 shrink-0 overflow-hidden bg-ink-850 max-h-[420px]">
      {header}
      {body}
    </section>
  );
}

function Chip({
  tone,
  value,
  label,
  tooltip,
}: {
  tone: keyof typeof TONE;
  value: string;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip content={tooltip} side="bottom">
      <span className="inline-flex items-center gap-1 cursor-help shrink-0">
        <span className={clsx('tabular-nums', TONE[tone])}>{value}</span>
        <span className="text-fog-700 uppercase tracking-widest2">{label}</span>
      </span>
    </Tooltip>
  );
}
