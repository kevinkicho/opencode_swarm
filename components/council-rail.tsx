'use client';

// Council rail — pattern-specific tab for `council`. Every session does
// the same work each round; the tab's job is to show convergence across
// members per round so the user can spot "R2 drafts look 80% similar —
// we could stop here" long before R_max fires. Each row = one round;
// each column = one member's draft length. A trailing convergence chip
// summarizes how close the drafts are to each other.
//
// Spec frozen in docs/PATTERN_DESIGN/council.md §3.
//
// Convergence metric: pairwise token-jaccard on the last-round drafts
// (cheap, deterministic, order-invariant). >0.8 = high (mint), 0.5-0.8
// = med (amber), <0.5 = low (rust). Implemented inline to keep the
// component self-contained — if we later promote the metric to the
// backend (for I1 auto-stop) we swap the client function for an API
// read without touching the render path.

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveSwarmSessionSlot } from '@/lib/opencode/live';
import type { OpencodeMessage } from '@/lib/opencode/types';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { compactNum, countLines, turnText } from './rails/_shared';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';

interface MemberDraft {
  // Length in lines (cheap scan-density signal).
  lines: number;
  // Per-round per-member draft text, kept for the convergence compute.
  // Not rendered directly — the body is in the inspector drawer if the
  // user clicks.
  text: string;
  // For round ≥2: diff vs prior round of same member. Null otherwise.
  diffVsPrior: string | null;
  status: 'pending' | 'drafting' | 'completed' | 'errored';
  // PATTERN_DESIGN/council.md I2 — per-member direction persistence.
  // Token-jaccard between this member's draft in this round and their
  // own draft in the prior round. Null on R1 or when either side is
  // missing. >0.85 = stayed put; 0.5–0.85 = evolved; <0.5 = position
  // shift. The convergence metric tracks council-wide consensus; this
  // tracks each member's individual movement, which is a different
  // signal — a member can shift sharply while the council still
  // converges (everyone met in the middle).
  selfJaccard: number | null;
}

interface RoundRow {
  round: number; // 1-indexed
  members: MemberDraft[];
  // 0..1, null when <2 drafts are completed for this round.
  convergence: number | null;
  status: 'pending' | 'in-progress' | 'done';
}

// HARDENING_PLAN.md#C15 — `turnText` and `countLines` lifted to
// components/rails/_shared.ts. Pre-fix duplicated 5x across rails.

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

// Cheap tokenizer — lowercase, split on non-word, drop stopwords.
// Deterministic + fast enough for the max-few-hundred-lines-per-draft
// scale we expect. Full-text embedding would be overkill here.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that',
  'it', 'its', 'as', 'by', 'at', 'from', 'but', 'if', 'not', 'we',
  'you', 'i', 'they', 'our', 'your', 'their', 'his', 'her',
]);

function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

// Pairwise token-jaccard between two tokenized drafts. Used by I2 for
// per-member persistence (a vs same member's prior round). Distinct
// from aggregateJaccard's pairwise mean — that's a council-wide
// consensus metric, this is a per-member trajectory.
function pairJaccard(a: Set<string>, b: Set<string>): number | null {
  if (a.size === 0 && b.size === 0) return null;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = a.size + b.size - intersect;
  if (union === 0) return null;
  return intersect / union;
}

// Jaccard similarity across a set of tokenized drafts. Returns mean of
// pairwise jaccards — captures "how similar is the council as a whole"
// rather than any one pair. Symmetric + order-invariant. Range [0, 1].
function aggregateJaccard(sets: Set<string>[]): number | null {
  if (sets.length < 2) return null;
  let totalPairs = 0;
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
      totalPairs += 1;
    }
  }
  return totalPairs > 0 ? sum / totalPairs : null;
}

function convergenceTone(value: number | null): 'mint' | 'amber' | 'rust' | 'fog' {
  if (value === null) return 'fog';
  if (value >= 0.8) return 'mint';
  if (value >= 0.5) return 'amber';
  return 'rust';
}

function convergenceLabel(value: number | null): string {
  if (value === null) return '—';
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'med';
  return 'low';
}

// PATTERN_DESIGN/council.md I2 — stance bucket from self-jaccard.
// Three buckets matched to the convergence chip's tone palette so
// the eye groups them intuitively: stable = mint (no movement),
// evolved = fog-muted (some refinement), shifted = amber (strong
// repositioning). Null cases (R1 / pending) get fog and an empty glyph.
type StanceBucket = 'stable' | 'evolved' | 'shifted' | null;
function stanceBucket(j: number | null): StanceBucket {
  if (j === null) return null;
  if (j >= 0.85) return 'stable';
  if (j >= 0.5) return 'evolved';
  return 'shifted';
}
const STANCE_GLYPH: Record<NonNullable<StanceBucket>, string> = {
  stable: '=',
  evolved: '~',
  shifted: '↻',
};
const STANCE_TONE: Record<NonNullable<StanceBucket>, string> = {
  stable: 'text-mint/70',
  evolved: 'text-fog-700',
  shifted: 'text-amber',
};

export function CouncilRail({
  slots,
  embedded = false,
  // Accepted but not wired in v1 — council rows are rounds, not sessions,
  // so inspector wiring needs cell-level (per-member) clicks which
  // require restructuring the row component. Page passes this so a
  // future cell-level enhancement is non-breaking. IMPLEMENTATION_PLAN
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

// Stick-to-bottom-enabled body — IMPLEMENTATION_PLAN 6.7 + 6.8.
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

const STATUS_TONE: Record<RoundRow['status'], string> = {
  pending: 'text-fog-700',
  'in-progress': 'text-molten animate-pulse',
  done: 'text-fog-500',
};

const CONV_TEXT: Record<'mint' | 'amber' | 'rust' | 'fog', string> = {
  mint: 'text-mint',
  amber: 'text-amber',
  rust: 'text-rust',
  fog: 'text-fog-700',
};

// HARDENING_PLAN.md#C15 — `compactNum` lifted to rails/_shared.ts.

function CouncilRowEl({
  row,
  memberCount,
}: {
  row: RoundRow;
  memberCount: number;
}) {
  // Cap visible member columns at 4. Common council sizes are 3-5; a
  // 5-member run collapses to "+1" rather than pushing the convergence
  // chip off the visible area.
  const visible = row.members.slice(0, 4);
  const overflow = row.members.length - visible.length;
  const gridCols = `24px repeat(${visible.length}, 64px)${overflow > 0 ? ' 28px' : ''} 48px 64px`;
  const convTone = convergenceTone(row.convergence);

  return (
    <li
      className="h-6 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition"
      style={{ gridTemplateColumns: gridCols }}
      title={
        row.convergence !== null
          ? `R${row.round} · ${memberCount} members · convergence ${(row.convergence * 100).toFixed(0)}% (mean pairwise token-jaccard)`
          : `R${row.round} · waiting for drafts`
      }
    >
      <span className="text-fog-400 tabular-nums">R{row.round}</span>
      {visible.map((m, mi) => {
        const stance = stanceBucket(m.selfJaccard);
        const jaccardPct =
          m.selfJaccard !== null ? `${Math.round(m.selfJaccard * 100)}%` : null;
        const stanceTitle =
          stance && jaccardPct
            ? ` · stance: ${stance} (${jaccardPct} same as R${row.round - 1})`
            : '';
        return (
          <span
            key={mi}
            className={clsx(
              'tabular-nums text-[9.5px]',
              m.status === 'pending'
                ? 'text-fog-800'
                : m.status === 'drafting'
                  ? 'text-fog-300 animate-pulse'
                  : m.status === 'errored'
                    ? 'text-rust'
                    : 'text-fog-400',
            )}
            title={
              m.diffVsPrior
                ? `member ${mi + 1} · ${m.lines}L · ${m.diffVsPrior} vs R${row.round - 1}${stanceTitle}`
                : m.lines > 0
                  ? `member ${mi + 1} · ${m.lines}L${stanceTitle}`
                  : 'pending'
            }
          >
            {m.lines > 0 ? `${compactNum(m.lines)}L` : '—'}
            {stance && (
              <span className={clsx('ml-1 text-[8px]', STANCE_TONE[stance])}>
                {STANCE_GLYPH[stance]}
              </span>
            )}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="font-mono text-[9px] text-fog-700 text-center"
          title={`+${overflow} more member${overflow === 1 ? '' : 's'}`}
        >
          +{overflow}
        </span>
      )}
      <span
        className={clsx(
          'uppercase tracking-widest2 text-[9px] text-right',
          CONV_TEXT[convTone],
        )}
        title={
          row.convergence !== null
            ? `${(row.convergence * 100).toFixed(0)}% pairwise jaccard across ${row.members.filter((m) => m.status === 'completed').length} completed drafts`
            : 'need ≥2 completed drafts to compute'
        }
      >
        {convergenceLabel(row.convergence)}
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
