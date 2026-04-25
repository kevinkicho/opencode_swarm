'use client';

// Contracts rail — pattern-specific tab for blackboard runs (and any
// hierarchical pattern that pins an auditor / critic / verifier role).
// Surfaces the verdict-shape signals that the regular `board` tab
// buries: criterion auditor verdicts, critic-rejection notes, verifier
// pass/fail, CAS drift, retry counter — all in one scannable column
// per kind so the user can answer "what's actually contractually
// settled vs still in flight?" without reading every row's tooltip.
//
// Spec frozen in docs/PATTERN_DESIGN/blackboard.md §3. UI work shipped
// 2026-04-24 (Phase 1.1 of docs/IMPLEMENTATION_PLAN.md).
//
// Aesthetic: dense h-5 rows, monospace, tabular-nums, ink/fog/molten/
// mint/iris/amber palette only, micro-labels (10px uppercase
// tracking-widest2) on chips. Rust used sparingly — only on terminal
// failures (CRITIC busywork, VERIFIER fail, AUDIT unmet, RETRY 2).

import clsx from 'clsx';
import { useMemo, useRef } from 'react';

import type { LiveBoard } from '@/lib/blackboard/live';
import type { BoardItem, BoardItemStatus } from '@/lib/blackboard/types';
import { Tooltip } from './ui/tooltip';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { ScrollToBottomButton } from './ui/scroll-to-bottom';

// Per-row chip tone palette. Mint = good, rust = bad, amber = warning,
// fog = neutral / not applicable. Reused across columns so the eye
// learns "rust = action needed."
const TONE = {
  mint: 'text-mint',
  rust: 'text-rust',
  amber: 'text-amber',
  iris: 'text-iris',
  fog: 'text-fog-700',
  fogActive: 'text-fog-300',
} as const;

// Note-tag parsers. The coordinator stamps these on item.note when it
// transitions a row through a verdict gate. Format conventions (live as
// of 2026-04-24, see lib/server/blackboard/{coordinator,auto-ticker}.ts):
//
//   [retry:N] reason          retryOrStale (coordinator.ts:199)
//   [final after N retries]   final-stale stamp (coordinator.ts:212)
//   [cas-drift:<file>]        commit-time CAS rejection (coordinator.ts:778)
//   [critic-rejected] reason  anti-busywork critic verdict (coordinator.ts:847)
//   [verifier-rejected] reason Playwright verifier failure (coordinator.ts:903)
//   [audit:<verdict>] reason  auditor stamp on criterion (auto-ticker.ts:906)
//
// Pass-verdicts don't write a note (silent good news), so absence of a
// rejection tag is itself a signal. Display rule: explicit pass for
// 'done' status; explicit verdict text only for the rejection paths.

interface NoteSignals {
  retryCount: number;
  drift: string | null; // file path that drifted, when CAS triggered
  criticRejected: boolean;
  verifierRejected: boolean;
  auditVerdict: 'met' | 'unmet' | 'wont-do' | 'unclear' | null;
  finalAfterRetries: number | null; // stamp when the retry budget hit MAX
}

const RETRY_RE = /\[retry:(\d+)\]/;
const DRIFT_RE = /\[cas-drift:([^\]]+?)\]/;
const AUDIT_RE = /\[audit:([a-z-]+)\]/;
const FINAL_RE = /\[final after (\d+) retries?\]/;

function parseNote(note: string | null | undefined): NoteSignals {
  if (!note) {
    return {
      retryCount: 0,
      drift: null,
      criticRejected: false,
      verifierRejected: false,
      auditVerdict: null,
      finalAfterRetries: null,
    };
  }
  const retryM = RETRY_RE.exec(note);
  const driftM = DRIFT_RE.exec(note);
  const auditM = AUDIT_RE.exec(note);
  const finalM = FINAL_RE.exec(note);
  const auditRaw = auditM ? auditM[1] : null;
  const auditVerdict =
    auditRaw === 'met' ||
    auditRaw === 'unmet' ||
    auditRaw === 'wont-do' ||
    auditRaw === 'unclear'
      ? auditRaw
      : null;
  return {
    retryCount: retryM ? parseInt(retryM[1] ?? '0', 10) : 0,
    drift: driftM ? driftM[1] : null,
    criticRejected: /\[critic-rejected\]/.test(note),
    verifierRejected: /\[verifier-rejected\]/.test(note),
    auditVerdict,
    finalAfterRetries: finalM ? parseInt(finalM[1] ?? '0', 10) : null,
  };
}

// Per-status sort priority. In-progress first (active work the user is
// most likely tracking), then open (with retry-desc tiebreak so stuck
// items rise), then stale, then done, then claimed/blocked at the
// bottom. Criterion items sort by verdict severity as a secondary key.
const STATUS_RANK: Record<BoardItemStatus, number> = {
  'in-progress': 0,
  open: 1,
  stale: 2,
  blocked: 3,
  claimed: 4,
  done: 5,
};

const VERDICT_RANK: Record<NonNullable<NoteSignals['auditVerdict']>, number> = {
  unmet: 0,
  unclear: 1,
  'wont-do': 2,
  met: 3,
};

// Aggregate counts for the sticky header chips. Walk the items once and
// derive every chip in a single pass — cheap because items are typically
// dozens, and explicit aggregation is easier to read than 5 separate
// filter().length calls.
interface HeaderCounts {
  total: number;
  criteria: number;
  met: number;
  unmet: number;
  stale: number;
  busywork: number; // critic-rejected
  drift: number; // cas-drift
}

function deriveCounts(items: BoardItem[]): HeaderCounts {
  let criteria = 0,
    met = 0,
    unmet = 0,
    stale = 0,
    busywork = 0,
    drift = 0;
  for (const it of items) {
    const s = parseNote(it.note);
    if (it.kind === 'criterion') {
      criteria += 1;
      if (s.auditVerdict === 'met') met += 1;
      else if (s.auditVerdict === 'unmet') unmet += 1;
    }
    if (it.status === 'stale') stale += 1;
    if (s.criticRejected) busywork += 1;
    if (s.drift) drift += 1;
  }
  return {
    total: items.length,
    criteria,
    met,
    unmet,
    stale,
    busywork,
    drift,
  };
}

export function ContractsRail({
  live,
  embedded = false,
}: {
  live: LiveBoard;
  embedded?: boolean;
}) {
  const items = live.items ?? [];
  const counts = useMemo(() => deriveCounts(items), [items]);

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

  // Empty-state copy depends on whether ANY criteria exist. Two cases:
  // (a) board has items but no criteria → "no contracts yet — planner
  //     hasn't seeded criteria"
  // (b) board is entirely empty → "board hasn't started yet"
  if (items.length === 0) {
    return wrap(
      embedded,
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        board hasn't started yet
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

// One contract row — dense h-5, all columns aligned via grid so eyes
// can scan vertically by column. Spec column widths frozen in
// PATTERN_DESIGN/blackboard.md §3.
function ContractRow({ item }: { item: BoardItem }) {
  const sig = parseNote(item.note);

  // Glyph: ◆ for criterion (auditor-tracked contract), ● for todo with
  // requiresVerification, blank otherwise. Keeps the column scannable
  // without overloading every row with a marker.
  const glyph =
    item.kind === 'criterion'
      ? '◆'
      : item.requiresVerification
        ? '●'
        : '';
  const glyphTone =
    item.kind === 'criterion'
      ? sig.auditVerdict === 'met'
        ? TONE.mint
        : sig.auditVerdict === 'unmet'
          ? TONE.rust
          : sig.auditVerdict === 'wont-do'
            ? TONE.fogActive
            : TONE.amber
      : TONE.iris;

  const filesCount = item.expectedFiles?.length ?? 0;

  // Verdict chips — all reuse the same compact pattern: 3-letter code
  // colored by outcome, "—" placeholder when not gated / not yet
  // verdicted. Click would land in inspector for full text in a future
  // pass; for now the title attribute carries the full note.
  const driftChip = sig.drift ? (
    <span
      className={clsx('font-mono text-[9px]', TONE.amber)}
      title={`CAS drift on ${sig.drift}`}
    >
      drift
    </span>
  ) : (
    <span className={clsx('font-mono text-[9px]', TONE.fog)}>—</span>
  );

  const criticChip = sig.criticRejected ? (
    <span
      className={clsx('font-mono text-[9px]', TONE.rust)}
      title="anti-busywork critic rejected — see note"
    >
      BUSY
    </span>
  ) : item.status === 'done' ? (
    <span className={clsx('font-mono text-[9px]', TONE.mint)} title="critic passed (or not gated)">
      SUB
    </span>
  ) : (
    <span className={clsx('font-mono text-[9px]', TONE.fog)}>—</span>
  );

  const verifChip = sig.verifierRejected ? (
    <span
      className={clsx('font-mono text-[9px]', TONE.rust)}
      title="Playwright verifier rejected — see note"
    >
      FAIL
    </span>
  ) : item.requiresVerification && item.status === 'done' ? (
    <span className={clsx('font-mono text-[9px]', TONE.mint)} title="Playwright verifier passed">
      PASS
    </span>
  ) : (
    <span className={clsx('font-mono text-[9px]', TONE.fog)}>—</span>
  );

  const auditChip = sig.auditVerdict ? (
    <span
      className={clsx(
        'font-mono text-[9px]',
        sig.auditVerdict === 'met'
          ? TONE.mint
          : sig.auditVerdict === 'unmet'
            ? TONE.rust
            : sig.auditVerdict === 'wont-do'
              ? TONE.fogActive
              : TONE.amber,
      )}
      title={`auditor verdict: ${sig.auditVerdict}`}
    >
      {sig.auditVerdict === 'met'
        ? 'MET'
        : sig.auditVerdict === 'unmet'
          ? 'UNMET'
          : sig.auditVerdict === 'wont-do'
            ? 'WONT'
            : '?'}
    </span>
  ) : (
    <span className={clsx('font-mono text-[9px]', TONE.fog)}>—</span>
  );

  // Retry budget. retryOrStale caps at MAX_STALE_RETRIES=2; show as
  // N/2 so the user immediately knows where in the budget the item
  // sits. Tone: 0 muted, 1 amber, 2 rust (exhausted).
  const retryDisplay = sig.finalAfterRetries ?? sig.retryCount;
  const retryChip = (
    <span
      className={clsx(
        'font-mono text-[9px] tabular-nums',
        retryDisplay >= 2 ? TONE.rust : retryDisplay >= 1 ? TONE.amber : TONE.fog,
      )}
      title={
        sig.finalAfterRetries !== null
          ? `retry budget exhausted at ${sig.finalAfterRetries}/2`
          : `retry counter: ${retryDisplay}/2`
      }
    >
      {retryDisplay}/2
    </span>
  );

  // Status row tint: stale rows get a subtle amber background so the
  // eye finds them without scanning per-cell chips. Done rows are
  // dimmed to push attention toward in-progress / open work. Critic-
  // and verifier-rejected items get rust tint to flag they're failing
  // a contract, not just stale.
  const rowTint =
    item.status === 'stale'
      ? 'bg-amber/[0.04]'
      : item.status === 'done'
        ? 'opacity-65'
        : sig.criticRejected || sig.verifierRejected
          ? 'bg-rust/[0.06]'
          : '';

  return (
    <li
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono cursor-default hover:bg-ink-800/40 transition',
        rowTint,
      )}
      style={{
        // glyph 16 · label flex · files 32 · drift 56 · critic 32 ·
        // verif 36 · audit 44 · retry 28
        gridTemplateColumns: '16px minmax(0, 1fr) 32px 56px 32px 36px 44px 28px',
      }}
      title={item.note ?? undefined}
    >
      <span className={clsx('text-center leading-none', glyphTone)} aria-label={item.kind}>
        {glyph}
      </span>
      <span className="text-fog-200 truncate min-w-0" title={item.content}>
        {item.content}
      </span>
      <span className={clsx('tabular-nums text-right', filesCount > 0 ? TONE.fogActive : TONE.fog)}>
        {filesCount > 0 ? filesCount : '—'}
      </span>
      {driftChip}
      {criticChip}
      {verifChip}
      {auditChip}
      {retryChip}
    </li>
  );
}
