'use client';

// Roles rail — pattern-specific tab for `role-differentiated`. One row
// per role, showing how much work each role has actually claimed and
// completed vs. how much was nominally for them (match-rate). Lets the
// user spot imbalances ("the architect did 90% of work") and
// preferredRole vs. claimant mismatches ("tester kept claiming
// security-tagged items") at a glance.
//
// Spec frozen in docs/PATTERN_DESIGN/role-differentiated.md §3.
//
// Data: comes from two sources joined client-side:
//   - boardRoleNames (passed down from page.tsx) — sessionID → role
//     name map, from the run's teamRoles preset
//   - live.items (BoardItem[]) — claims have ownerAgentId; preferredRole
//     is set on items the planner tagged with `[role:<name>]`.
// We fold the two together to count claimed/done/stale per role + the
// preferredRole-match rate.

import clsx from 'clsx';
import { useMemo } from 'react';

import type { LiveBoard } from '@/lib/blackboard/live';
import type { BoardItem } from '@/lib/blackboard/types';

interface RoleRow {
  role: string;
  // Slot index for stable ordering (s0, s1, …) and the session label.
  slotIndex: number;
  claimed: number;
  done: number;
  stale: number;
  // Of items this role claimed where preferredRole was set, fraction
  // that match the role itself. Null when no claimed-with-preferredRole
  // items exist (no signal to compute).
  matchRate: number | null;
  matchTotal: number;
  // Average wall-clock between createdAtMs and completedAtMs for done
  // items claimed by this role. Null when no done items exist.
  avgMinutes: number | null;
  // Current activity inferred from the role's most-recent claim status.
  status: 'idle' | 'claiming' | 'working' | 'error';
  // Session that holds this role, used by the inspector wiring.
  sessionID: string;
}

// Reserved accent per canonical role. The stigmergy of the kept palette:
// related roles share family tones (data/docs are both fog because
// they're observation-shaped; security gets rust because failures there
// are higher-stakes than failures elsewhere). Maps to our existing tone
// classes — keep aligned with palette references in
// PATTERN_DESIGN/role-differentiated.md §3.
const ROLE_ACCENT: Record<string, string> = {
  architect: 'bg-iris',
  builder: 'bg-molten',
  tester: 'bg-amber',
  reviewer: 'bg-mint',
  security: 'bg-rust',
  ux: 'bg-fog-500',
  data: 'bg-iris/60',
  docs: 'bg-fog-500/70',
};

const ROLE_TEXT: Record<string, string> = {
  architect: 'text-iris',
  builder: 'text-molten',
  tester: 'text-amber',
  reviewer: 'text-mint',
  security: 'text-rust',
  ux: 'text-fog-300',
  data: 'text-iris',
  docs: 'text-fog-400',
};

function fallbackAccent(name: string): string {
  // Hash-derived accent for unrecognized roles so the rail never shows
  // a blank stripe. Stable per role name.
  const palette = [
    'bg-iris',
    'bg-molten',
    'bg-amber',
    'bg-mint',
    'bg-fog-500',
  ];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function fallbackText(name: string): string {
  const palette = ['text-iris', 'text-molten', 'text-amber', 'text-mint', 'text-fog-300'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export function RolesRail({
  live,
  roleNames,
  sessionIDs,
  embedded = false,
  onInspectSession,
}: {
  live: LiveBoard;
  // sessionID → role name (from run meta + teamRoles preset). Pass an
  // empty map and we fall back to numeric labels.
  roleNames: ReadonlyMap<string, string>;
  // Run's session IDs in declared slot order. Used to derive s0/s1/…
  // session labels per role.
  sessionIDs: string[];
  embedded?: boolean;
  onInspectSession?: (sessionID: string) => void;
}) {
  const rows = useMemo<RoleRow[]>(() => {
    const items = live.items ?? [];
    // Build role → slotIndex from the sessionID list + roleNames map.
    // If roleNames is empty (no preset), use numeric labels keyed by slot.
    const roleBySlot = new Map<number, string>();
    sessionIDs.forEach((sid, idx) => {
      const r = roleNames.get(sid);
      if (r) roleBySlot.set(idx, r);
    });

    // Aggregator: per role, walk items, count claims / dones / stales
    // and gather a sample for avg-time + match-rate.
    interface Acc {
      role: string;
      slotIndex: number;
      claimed: number;
      done: number;
      stale: number;
      matchHits: number;
      matchTotal: number;
      doneDurationsMs: number[];
      hasInProgress: boolean;
      hasError: boolean;
    }
    const accByRole = new Map<string, Acc>();
    for (const [slotIndex, role] of roleBySlot) {
      accByRole.set(role, {
        role,
        slotIndex,
        claimed: 0,
        done: 0,
        stale: 0,
        matchHits: 0,
        matchTotal: 0,
        doneDurationsMs: [],
        hasInProgress: false,
        hasError: false,
      });
    }

    // Owner → role lookup. ownerAgentId is the SESSION_ID (per
    // coordinator.ts) — same key roleNames uses. Direct lookup.
    function roleOfOwner(ownerId: string | undefined): Acc | null {
      if (!ownerId) return null;
      const r = roleNames.get(ownerId);
      return r ? accByRole.get(r) ?? null : null;
    }

    for (const it of items) {
      const acc = roleOfOwner(it.ownerAgentId);
      if (!acc) continue;
      acc.claimed += 1;
      if (it.status === 'done') acc.done += 1;
      else if (it.status === 'stale') acc.stale += 1;
      else if (it.status === 'in-progress' || it.status === 'claimed') {
        acc.hasInProgress = true;
      }
      if (it.preferredRole) {
        acc.matchTotal += 1;
        if (it.preferredRole === acc.role) acc.matchHits += 1;
      }
      if (
        it.status === 'done' &&
        it.completedAtMs &&
        it.createdAtMs &&
        it.completedAtMs > it.createdAtMs
      ) {
        acc.doneDurationsMs.push(it.completedAtMs - it.createdAtMs);
      }
    }

    return Array.from(accByRole.values())
      .sort((a, b) => b.done - a.done || a.slotIndex - b.slotIndex)
      .map<RoleRow>((acc) => {
        const matchRate =
          acc.matchTotal > 0 ? acc.matchHits / acc.matchTotal : null;
        const avgMs =
          acc.doneDurationsMs.length > 0
            ? acc.doneDurationsMs.reduce((s, x) => s + x, 0) /
              acc.doneDurationsMs.length
            : null;
        const status: RoleRow['status'] = acc.hasError
          ? 'error'
          : acc.hasInProgress
            ? 'working'
            : 'idle';
        return {
          role: acc.role,
          slotIndex: acc.slotIndex,
          claimed: acc.claimed,
          done: acc.done,
          stale: acc.stale,
          matchRate,
          matchTotal: acc.matchTotal,
          avgMinutes: avgMs ? avgMs / 60_000 : null,
          status,
          sessionID: sessionIDs[acc.slotIndex] ?? '',
        };
      });
  }, [live.items, roleNames, sessionIDs]);

  // Header chips: total claims, overall match-rate, slowest role.
  const header = useMemo(() => {
    const totalClaims = rows.reduce((s, r) => s + r.claimed, 0);
    const totalMatchHits = rows.reduce(
      (s, r) => s + (r.matchRate !== null ? r.matchRate * r.matchTotal : 0),
      0,
    );
    const totalMatchOpps = rows.reduce((s, r) => s + r.matchTotal, 0);
    const overallMatch =
      totalMatchOpps > 0 ? Math.round((totalMatchHits / totalMatchOpps) * 100) : null;
    const slowest = rows
      .filter((r) => r.avgMinutes !== null)
      .sort((a, b) => (b.avgMinutes ?? 0) - (a.avgMinutes ?? 0))[0];
    return { totalClaims, overallMatch, slowest };
  }, [rows]);

  if (rows.length === 0) {
    return wrap(
      embedded,
      'awaiting role assignments',
      <div className="px-3 py-4 font-mono text-micro uppercase tracking-widest2 text-fog-700">
        no role assignments yet — run hasn't dispatched per-role intros
      </div>,
    );
  }

  return wrap(
    embedded,
    `${header.totalClaims} claim${header.totalClaims === 1 ? '' : 's'}` +
      (header.overallMatch !== null ? ` · match ${header.overallMatch}%` : '') +
      (header.slowest
        ? ` · slow ${header.slowest.role} ${(header.slowest.avgMinutes ?? 0).toFixed(0)}m`
        : ''),
    <ul className="flex-1 overflow-y-auto overflow-x-hidden py-1 list-none min-h-0">
      {rows.map((r) => (
        <RoleRowEl key={r.role} row={r} onInspectSession={onInspectSession} />
      ))}
    </ul>,
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
        roles
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

const STATUS_TONE: Record<RoleRow['status'], string> = {
  idle: 'text-fog-700',
  claiming: 'text-iris animate-pulse',
  working: 'text-molten animate-pulse',
  error: 'text-rust',
};

function RoleRowEl({
  row,
  onInspectSession,
}: {
  row: RoleRow;
  onInspectSession?: (sessionID: string) => void;
}) {
  const accentBg = ROLE_ACCENT[row.role] ?? fallbackAccent(row.role);
  const accentText = ROLE_TEXT[row.role] ?? fallbackText(row.role);
  const matchPct =
    row.matchRate !== null ? Math.round(row.matchRate * 100) : null;
  const clickable = !!(onInspectSession && row.sessionID);
  const onClick = clickable ? () => onInspectSession!(row.sessionID) : undefined;

  return (
    <li
      onClick={onClick}
      className={clsx(
        'h-5 px-3 grid items-center gap-1.5 text-[10.5px] font-mono transition relative',
        clickable
          ? 'cursor-pointer hover:bg-ink-800/60'
          : 'cursor-default hover:bg-ink-800/40',
      )}
      style={{
        // stripe 4 · role 88 · session 32 · claimed 40 · done 40 · stale 40
        // · match 64 · avg 40 · status 64
        gridTemplateColumns: '4px 88px 32px 40px 40px 40px 64px 40px 64px',
      }}
      title={`role ${row.role} · slot s${row.slotIndex}`}
    >
      <span className={clsx('h-3 w-1 rounded-sm', accentBg)} aria-hidden />
      <span className={clsx('uppercase tracking-widest2 text-[10px] truncate', accentText)}>
        {row.role}
      </span>
      <span className="font-mono text-[9px] text-fog-500 tabular-nums">
        s{row.slotIndex}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.claimed > 0 ? 'text-fog-200' : 'text-fog-700',
        )}
      >
        {row.claimed}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.done > 0 ? 'text-mint' : 'text-fog-700',
        )}
      >
        {row.done}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.stale > 0 ? 'text-amber' : 'text-fog-700',
        )}
      >
        {row.stale}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right text-[9.5px]',
          matchPct === null ? 'text-fog-700' : matchPct >= 50 ? 'text-mint' : 'text-amber',
        )}
        title={
          matchPct === null
            ? 'no preferredRole signals yet'
            : `${matchPct}% of ${row.matchTotal} claims with preferredRole hit this role`
        }
      >
        {matchPct === null ? '—' : `${matchPct}%/${row.matchTotal}`}
      </span>
      <span
        className={clsx(
          'tabular-nums text-right',
          row.avgMinutes !== null ? 'text-fog-400' : 'text-fog-700',
        )}
      >
        {row.avgMinutes !== null
          ? row.avgMinutes < 10
            ? `${row.avgMinutes.toFixed(1)}m`
            : `${Math.round(row.avgMinutes)}m`
          : '—'}
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
