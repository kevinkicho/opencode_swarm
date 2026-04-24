'use client';

// Iterations rail — pattern-specific tab for `critic-loop`. Surfaces the
// draft → review → revise loop as a vertical timeline of iteration
// entries, oldest first (left-to-right reading order matches how the
// loop actually plays out). Each iteration produces two rows: a worker
// draft (#N) and a critic review (#Nr).
//
// Spec frozen in docs/PATTERN_DESIGN/critic-loop.md §3. Implements
// PATTERN_DESIGN ledger entry `iterations-tab`.
//
// Data: per-session message arrays from useLiveSwarmRunMessages.slots.
// Critic-loop kickoff (lib/server/critic-loop.ts) pins session 0 = worker,
// session 1 = critic, with agent='worker' / 'critic' on the opencode
// message info. We could trust slot ORDER, but it's safer to identify
// the worker / critic by agent name on the first assistant message we
// see — that way a future kickoff change that swaps slot order doesn't
// silently mis-label the rows.

import clsx from 'clsx';
import { useMemo } from 'react';

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';

interface IterationRow {
  // `#1` for first draft, `#1r` for first review, `#2` for second draft, …
  label: string;
  actor: 'worker' | 'critic';
  status: 'drafting' | 'completed' | 'errored' | 'reviewing' | 'approved' | 'revising';
  // Length in lines (compact-readable signal of "how much" was generated).
  lengthLines: number;
  // For drafts past iteration 1, a short diff-summary against prior draft;
  // for reviews, the parsed verdict keyword. Null when neither applies.
  keySummary: string | null;
  keyTone: 'mint' | 'amber' | 'rust' | 'fog' | null;
  // ms timestamp of message creation, used for sort + display.
  ts: number | null;
}

// Extract assistant turn body as plain text. Walks parts, concatenates
// text + reasoning content. Skips tool / step parts since they're
// orchestration noise from the iteration-flow POV.
function turnText(m: OpencodeMessage): string {
  let out = '';
  for (const p of m.parts) {
    if (p.type === 'text' || p.type === 'reasoning') {
      const t = (p as { text?: string }).text ?? '';
      out += t;
    }
  }
  return out;
}

// Cheap line-count for a string. Matches what the inspector drawer
// would show as draft length; consistent across rows.
function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

// Diff summary: cheap symmetric-difference of line sets, not a real
// edit script. Captures "approximately how many lines moved" with one
// pass, which is what the scan-density column needs. A real Myers
// diff would be overkill for a single-line summary glyph.
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

// Parse the critic verdict from review text. critic-loop's prompt
// contract (buildCriticIntroPrompt, lib/server/critic-loop.ts) asks
// the critic to start its reply with APPROVED or REVISE. Be lenient
// about case and surrounding whitespace.
function parseVerdict(text: string): 'approved' | 'revise' | 'unknown' {
  if (!text) return 'unknown';
  const head = text.trimStart().slice(0, 32).toUpperCase();
  if (head.startsWith('APPROVED')) return 'approved';
  if (head.startsWith('REVISE')) return 'revise';
  return 'unknown';
}

// Identify worker / critic slots from the run's session metadata. Trust
// the `agent` field on the first assistant message; fall back to slot
// order when both names are missing (mock data / older runs).
function classifySlots(slots: LiveSwarmSessionSlot[]): {
  worker: LiveSwarmSessionSlot | null;
  critic: LiveSwarmSessionSlot | null;
} {
  let worker: LiveSwarmSessionSlot | null = null;
  let critic: LiveSwarmSessionSlot | null = null;
  for (const s of slots) {
    const firstAssist = s.messages.find((m) => m.info.role === 'assistant');
    const agent = firstAssist?.info.agent;
    if (agent === 'worker' && !worker) worker = s;
    else if (agent === 'critic' && !critic) critic = s;
  }
  if (!worker) worker = slots[0] ?? null;
  if (!critic) critic = slots[1] ?? null;
  if (worker && worker === critic) critic = null;
  return { worker, critic };
}

export function IterationsRail({
  slots,
  embedded = false,
}: {
  slots: LiveSwarmSessionSlot[];
  embedded?: boolean;
}) {
  const rows = useMemo<IterationRow[]>(() => {
    const { worker, critic } = classifySlots(slots);
    const drafts = (worker?.messages ?? []).filter(
      (m) => m.info.role === 'assistant',
    );
    const reviews = (critic?.messages ?? []).filter(
      (m) => m.info.role === 'assistant',
    );
    const out: IterationRow[] = [];
    let prevDraftText = '';
    const total = Math.max(drafts.length, reviews.length);
    for (let i = 0; i < total; i += 1) {
      const draft = drafts[i];
      const review = reviews[i];

      if (draft) {
        const text = turnText(draft);
        const lines = countLines(text);
        const completed = !!draft.info.time.completed;
        const errored = !!draft.info.error;
        const status: IterationRow['status'] = errored
          ? 'errored'
          : completed
            ? 'completed'
            : 'drafting';
        let keySummary: string | null = null;
        let keyTone: IterationRow['keyTone'] = null;
        if (i > 0 && prevDraftText) {
          const summary = diffSummary(prevDraftText, text);
          keySummary = summary;
          keyTone = summary === 'no change' ? 'amber' : 'fog';
        }
        out.push({
          label: `#${i + 1}`,
          actor: 'worker',
          status,
          lengthLines: lines,
          keySummary,
          keyTone,
          ts: draft.info.time.completed ?? draft.info.time.created ?? null,
        });
        prevDraftText = text;
      }

      if (review) {
        const text = turnText(review);
        const lines = countLines(text);
        const verdict = parseVerdict(text);
        const completed = !!review.info.time.completed;
        const status: IterationRow['status'] = !completed
          ? 'reviewing'
          : verdict === 'approved'
            ? 'approved'
            : verdict === 'revise'
              ? 'revising'
              : 'completed';
        const verdictText =
          verdict === 'approved'
            ? 'APPROVED'
            : verdict === 'revise'
              ? 'REVISE'
              : '?';
        const verdictTone: IterationRow['keyTone'] =
          verdict === 'approved' ? 'mint' : verdict === 'revise' ? 'amber' : 'fog';
        out.push({
          label: `#${i + 1}r`,
          actor: 'critic',
          status,
          lengthLines: lines,
          keySummary: completed ? verdictText : null,
          keyTone: completed ? verdictTone : null,
          ts: review.info.time.completed ?? review.info.time.created ?? null,
        });
      }
    }
    return out;
  }, [slots]);

  // Header summary. Final-approval pin if any row is `approved`.
  const finalApproved = rows.findIndex((r) => r.status === 'approved');
  const draftCount = rows.filter((r) => r.actor === 'worker').length;
  const headerStatus =
    finalApproved >= 0
      ? `approved at #${Math.floor(finalApproved / 2) + 1}`
      : draftCount === 0
        ? 'awaiting first draft'
        : `iteration ${draftCount}`;

  if (rows.length === 0) {
    return wrap(
      embedded,
      headerStatus,
      finalApproved >= 0,
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        awaiting first draft — worker drafting
      </div>,
    );
  }

  return wrap(
    embedded,
    headerStatus,
    finalApproved >= 0,
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none min-h-0">
      {rows.map((r, i) => (
        <IterationRowEl key={i} row={r} approved={i === finalApproved} />
      ))}
    </ul>,
  );
}

function wrap(
  embedded: boolean,
  headerStatus: string,
  hasApproval: boolean,
  body: React.ReactNode,
) {
  const header = (
    <div className="h-7 hairline-b px-3 flex items-center gap-2 bg-ink-850/80 backdrop-blur shrink-0">
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 shrink-0">
        iterations
      </span>
      <span
        className={clsx(
          'font-mono text-micro tabular-nums',
          hasApproval ? 'text-mint' : 'text-fog-700',
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

const ACTOR_TONE: Record<IterationRow['actor'], string> = {
  worker: 'text-molten',
  critic: 'text-iris',
};

const STATUS_TONE: Record<IterationRow['status'], string> = {
  drafting: 'text-molten animate-pulse',
  reviewing: 'text-iris animate-pulse',
  completed: 'text-fog-500',
  approved: 'text-mint',
  revising: 'text-amber',
  errored: 'text-rust',
};

const KEY_TONE: Record<NonNullable<IterationRow['keyTone']>, string> = {
  mint: 'text-mint',
  amber: 'text-amber',
  rust: 'text-rust',
  fog: 'text-fog-500',
};

function fmtTimeOfDay(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function compactNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function IterationRowEl({
  row,
  approved,
}: {
  row: IterationRow;
  approved: boolean;
}) {
  return (
    <li
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition',
        approved && 'bg-mint/[0.08]',
      )}
      style={{
        // iter 28 · actor 48 · status 64 · length 40 · key flex · time 40
        gridTemplateColumns: '28px 48px 64px 40px minmax(0, 1fr) 40px',
      }}
      title={row.keySummary ?? undefined}
    >
      <span className="text-fog-400 tabular-nums">{row.label}</span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px]',
          ACTOR_TONE[row.actor],
        )}
      >
        {row.actor}
      </span>
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px]',
          STATUS_TONE[row.status],
        )}
      >
        {row.status}
      </span>
      <span className="tabular-nums text-right text-fog-500">
        {compactNum(row.lengthLines)}L
      </span>
      <span className="truncate min-w-0">
        {row.keySummary && row.keyTone ? (
          <span className={clsx('uppercase tracking-widest2 text-[9px]', KEY_TONE[row.keyTone])}>
            {row.keySummary}
          </span>
        ) : (
          <span className="text-fog-700">—</span>
        )}
      </span>
      <span className="tabular-nums text-right text-fog-700">
        {fmtTimeOfDay(row.ts)}
      </span>
    </li>
  );
}
