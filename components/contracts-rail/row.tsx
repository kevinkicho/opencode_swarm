'use client';

// One contract row — dense h-5, all columns aligned via grid so eyes
// can scan vertically by column.
//
// Each row renders 8 columns: glyph · label · files-count · drift ·
// critic · verifier · audit · retry. Tone-by-outcome chip rendering
// keeps "rust = action needed" consistent with the header.
//
// Lifted from contracts-rail.tsx 2026-04-28 — pure render driven by
// the BoardItem prop; pulls TONE + parseNote from the sibling
// note-parser module so no parsing logic duplicates.

import clsx from 'clsx';
import type { BoardItem } from '@/lib/blackboard/types';
import { TONE, parseNote } from './note-parser';

export function ContractRow({ item }: { item: BoardItem }) {
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
