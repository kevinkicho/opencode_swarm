'use client';

//
// Per-item row in the inline board rail. Lifted from board-rail.tsx
// along with its 5 helpers: KIND_GLYPH/TONE (kind tone tables),
// retryCountFromNote (parses [retry:N] tag), heatBarTone (color tier
// for the heat bar), ACCENT_BG (per-agent accent class).
//
// Stays in a sibling rather than the main file because BoardRailRow
// is the per-row presentation (~180 LOC of dense JSX with conditional
// chip rendering) and the main file is the table shell.

import clsx from 'clsx';

import type { BoardAgent, BoardItem, BoardItemKind, BoardItemStatus } from '@/lib/blackboard/types';
import { Tooltip } from '../ui/tooltip';

// Per-kind glyph. Todo is the default kind — we leave its glyph blank so
// the row reads as content-first. Other kinds get a one-char marker
// because they're structurally distinct.
const KIND_GLYPH: Record<BoardItemKind, string> = {
  claim: '◎',
  question: '?',
  todo: '',
  finding: '✓',
  synthesize: 'Σ',
  criterion: '◆',
};

const KIND_TONE: Record<BoardItemKind, string> = {
  claim: 'text-iris',
  question: 'text-amber',
  todo: 'text-fog-400',
  finding: 'text-mint',
  synthesize: 'text-mint',
  criterion: 'text-amber',
};

// Parse the retry counter out of a coordinator-stamped note. Format from
// retryOrStale() in coordinator.ts: `[retry:N] reason text`.
const RETRY_TAG_RE = /^\[retry:(\d+)\]/;
function retryCountFromNote(note: string | null | undefined): number {
  if (!note) return 0;
  const m = RETRY_TAG_RE.exec(note);
  return m ? Math.max(0, parseInt(m[1] ?? '0', 10)) : 0;
}

// Strip the leading `[audit:...]` / `[retry:N]` tag so the inline
// subtitle on blocked rows reads naturally. The tooltip still shows
// the full tagged note for forensics; the inline rendering wants the
// human-readable reason without the bookkeeping prefix.
const TAG_PREFIX_RE = /^\[[a-z][a-z0-9-]*(?::[^\]]*)?\]\s*/;
function stripTagPrefix(note: string): string {
  return note.replace(TAG_PREFIX_RE, '').trim();
}

// Tone steps from : 0 = fog-700 (cold,
// picker-preferred), 1-20% of max = amber/30, 20-50% = amber/50,
// 50-100% = molten/40 (hot, picker avoids on the exploratory bias).
function heatBarTone(scoreFraction: number): string {
  if (scoreFraction <= 0) return 'bg-fog-700/60';
  if (scoreFraction < 0.2) return 'bg-amber/30';
  if (scoreFraction < 0.5) return 'bg-amber/50';
  return 'bg-molten/40';
}

const ACCENT_BG: Record<BoardAgent['accent'], string> = {
  molten: 'bg-molten/20 text-molten',
  mint: 'bg-mint/20 text-mint',
  iris: 'bg-iris/20 text-iris',
  amber: 'bg-amber/20 text-amber',
  fog: 'bg-fog-700/40 text-fog-300',
};

export function BoardRailRow({
  item,
  owner,
  heatScore,
  maxHeatScore,
}: {
  item: BoardItem;
  owner: BoardAgent | null;
  // Stigmergy heat score for this row. 0 = no heat / not open. Used
  // with maxHeatScore to render a relative-width bar.
  heatScore: number;
  maxHeatScore: number;
}) {
  const isStale = item.status === 'stale';
  // Heat decoration is open-status only — the picker only scores open
  // items, so anything else has score=0 and we drop the bar entirely.
  // When the run has zero heat data (no patches yet), maxHeatScore=0
  // and we drop the bar across the board to avoid a row of dead chips.
  const showHeat = item.status === 'open' && maxHeatScore > 0;
  const heatFraction = showHeat ? heatScore / maxHeatScore : 0;
  return (
    <Tooltip
      side="right"
      wide
      content={
        <div className="space-y-1 max-w-[340px]">
          <div className="font-mono text-[11px] text-fog-200 leading-snug break-words">
            {item.content}
          </div>
          <div className="font-mono text-[10px] text-fog-500 flex items-center gap-1 flex-wrap">
            <span className={KIND_TONE[item.kind]}>{item.kind}</span>
            <span className="text-fog-700">·</span>
            <span className="uppercase tracking-widest2">{item.status}</span>
            {owner && (
              <>
                <span className="text-fog-700">·</span>
                <span className="text-fog-300">{owner.name}</span>
              </>
            )}
            <span className="text-fog-700">·</span>
            <span className="tabular-nums">{item.id}</span>
          </div>
          {isStale && item.staleSinceSha && (
            <div className="font-mono text-[10px] text-amber">
              files moved · head now {item.staleSinceSha}
            </div>
          )}
          {item.fileHashes && item.fileHashes.length > 0 && (
            <div className="font-mono text-[10px] text-fog-500 leading-snug">
              {item.fileHashes.map((f) => (
                <div key={f.path} className="flex items-center gap-1">
                  <span className="text-fog-600 truncate">{f.path}</span>
                  <span className="text-fog-700">@</span>
                  <span className="text-fog-400 tabular-nums">{f.sha}</span>
                </div>
              ))}
            </div>
          )}
          {item.note && (
            <div className="font-mono text-[10px] text-fog-500 italic leading-snug">
              {item.note}
            </div>
          )}
        </div>
      }
    >
      <div className="pl-5 pr-2 h-6 flex items-center gap-1.5 hover:bg-ink-800/40 cursor-default transition">
        {KIND_GLYPH[item.kind] && (
          <span
            className={clsx(
              'shrink-0 w-3 text-center font-mono text-[11px] leading-none',
              KIND_TONE[item.kind]
            )}
            aria-label={item.kind}
          >
            {KIND_GLYPH[item.kind]}
          </span>
        )}
        <span className="text-[11.5px] text-fog-200 truncate flex-1 min-w-0 font-mono">
          {item.content}
        </span>
        {(() => {
          const retries = retryCountFromNote(item.note);
          if (retries <= 0) return null;
          // Tone steps: 1 retry → amber (warning), 2 retries → rust (max
          // out, retryOrStale gives up after MAX_STALE_RETRIES=2). Keeps
          // the eye drawn to truly-exhausted items while still flagging
          // the once-failed ones.
          const tone = retries >= 2 ? 'text-rust' : 'text-amber';
          return (
            <span
              className={clsx(
                'shrink-0 font-mono text-[9px] tabular-nums',
                tone,
              )}
              title={`retried ${retries}× · ${item.note ?? ''}`}
            >
              ↻{retries}
            </span>
          );
        })()}
        {item.pickedByHeat && (
          <span
            className="shrink-0 font-mono text-[10px] text-amber"
            title="heat-weighted pick — stigmergy preferred this over oldest-first"
            aria-label="heat-weighted pick"
          >
            🜂
          </span>
        )}
        {isStale && item.staleSinceSha && (
          <span
            className="shrink-0 font-mono text-[9px] text-amber tabular-nums"
            title={`files moved · head ${item.staleSinceSha}`}
          >
            ↯{item.staleSinceSha.slice(0, 4)}
          </span>
        )}
        {/* Audit chip — surfaces a verdict from the auditor session in
            the row itself (the full reason is also in the tooltip
            below, but the tooltip is hover-only and the chip makes
            "this row was audited" discoverable at a glance). Color
            tracks the row status: rust for blocked (audit failed), mint
            for done (audit confirmed), fog for anything else. */}
        {item.note?.startsWith('[audit:') && (
          <span
            className={clsx(
              'shrink-0 font-mono text-[9px] uppercase tracking-wider',
              item.status === 'blocked' && 'text-rust',
              item.status === 'done' && 'text-mint',
              item.status !== 'blocked' && item.status !== 'done' && 'text-fog-500',
            )}
            title={`auditor: ${stripTagPrefix(item.note)}`}
          >
            audit
          </span>
        )}
        {showHeat && (
          <span
            className="shrink-0 flex items-center gap-1"
            title={
              heatScore > 0
                ? `heat ${heatScore} / max ${maxHeatScore} · picker avoids hot rows on the exploratory bias`
                : 'heat 0 — picker prefers cold rows'
            }
          >
            <span
              className="block h-[3px] rounded-sm bg-ink-900"
              style={{ width: 24 }}
              aria-hidden
            >
              <span
                className={clsx('block h-full rounded-sm', heatBarTone(heatFraction))}
                style={{ width: `${Math.max(8, heatFraction * 100)}%` }}
              />
            </span>
            <span
              className={clsx(
                'font-mono text-[9px] tabular-nums w-5 text-right',
                heatScore > 0 ? 'text-fog-500' : 'text-fog-800',
              )}
            >
              {heatScore > 0 ? heatScore : '·'}
            </span>
          </span>
        )}
        {owner ? (
          <span
            className={clsx(
              'shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none tabular-nums',
              ACCENT_BG[owner.accent]
            )}
            title={`session ${owner.name} · ${owner.id}`}
          >
            {owner.glyph}
          </span>
        ) : (
          <span
            className="shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[9.5px] leading-none text-fog-700 bg-ink-800"
            title="unclaimed"
          >
            —
          </span>
        )}
      </div>
    </Tooltip>
  );
}

// TickerChip — surfaces the per-run auto-ticker state as a compact footer row.
// Three shapes:
//   - none     → fog dot, "none" (no ticker has ever run for this swarmRunID)
//   - active   → mint dot (pulse while inFlight), idle counter "idle N/M" when
//                consecutiveIdle > 0, tone escalates to amber past ⅔ of the
//                auto-idle threshold so the user sees "about to stop" coming.
//   - stopped  → amber dot, reason label, inline "restart" button. Clicking
//                calls ticker.start() which hits POST /board/ticker {start}.
// Title attribute carries started/last-tick/last-outcome detail for hover
// inspection; the visible line stays h-6-friendly.
