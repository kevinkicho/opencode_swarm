// Glossary modal subcomponents — section cards + status rows + tooltips.
//
// Extracted from glossary-modal.tsx in #108. All purely presentational
// — no shared state, no side effects. Inlined into one file rather than
// scattered across per-component files because the parent modal is
// their only consumer and a per-file split would be more cognitive
// overhead than the small win is worth.

import clsx from 'clsx';
import type React from 'react';
import { Tooltip } from '../ui/tooltip';
import type { EventType, PartType, ToolName } from '@/lib/swarm-types';
import { partHex, partMeta, toolMeta } from '@/lib/part-taxonomy';
import { PartChip, ToolChip } from '../part-chip';
import {
  eventDetails,
  partDetails,
  toolDetails,
  type SessionStatusDetail,
  type ToolDetail,
  type ToolStateDetail,
} from './data';

export function SectionCard({
  label,
  count,
  hint,
  children,
}: {
  label: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md hairline bg-ink-900/40 overflow-hidden flex flex-col min-h-0">
      <header className="px-3 h-7 flex items-baseline gap-2 hairline-b bg-ink-900/60 shrink-0">
        <span className="font-mono text-micro uppercase tracking-widest2 text-molten">
          {label}
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">{count}</span>
        <span className="ml-auto font-mono text-[10px] text-fog-600 italic truncate">{hint}</span>
      </header>
      <div className="p-1.5 flex-1 min-h-0 overflow-y-auto">{children}</div>
    </section>
  );
}

// -------- Parts section -------------------------------------------------

export function PartsSection({ parts }: { parts: PartType[] }) {
  return (
    <SectionCard
      label="parts"
      count={parts.length}
      hint="PartType · message building blocks"
    >
      {parts.length === 0 ? (
        <EmptyHint />
      ) : (
        <ul
          className="grid gap-1"
          style={{
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateRows: `repeat(${Math.ceil(parts.length / 2)}, auto)`,
            gridAutoFlow: 'column',
          }}
        >
          {parts.map((p) => {
            const m = partMeta[p];
            const d = partDetails[p];
            const hex = partHex[p];
            return (
              <li key={p}>
                <Tooltip
                  side="top"
                  wide
                  content={<DeepTooltip title={p} hex={hex} detail={d.detail} meta={[
                    { k: 'via', v: d.carriedBy },
                    { k: 'lane', v: m.crossLane ? 'crosses lanes' : 'in-lane chip' },
                  ]} />}
                >
                  <div className="rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1.5 cursor-help">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-[86px] shrink-0 flex items-center">
                        <PartChip part={p} />
                      </span>
                      <span className="text-[10.5px] text-fog-400 leading-tight truncate flex-1">
                        {m.blurb}
                      </span>
                      <span className="w-[36px] shrink-0 flex items-center justify-start">
                        {m.crossLane && (
                          <span className="font-mono text-[8.5px] uppercase tracking-widest2 text-fog-600">
                            ×lane
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// -------- Tools section -------------------------------------------------

export function ToolsSection({ tools }: { tools: ToolName[] }) {
  const permissionLabel = (p: ToolDetail['permission']) =>
    p === 'never' ? 'auto' : p === 'sometimes' ? 'sometimes' : 'prompts';
  const permissionTone = (p: ToolDetail['permission']) =>
    p === 'never' ? 'text-mint' : p === 'sometimes' ? 'text-amber' : 'text-molten';

  return (
    <SectionCard
      label="tools"
      count={tools.length}
      hint="ToolName · 11 built-ins"
    >
      {tools.length === 0 ? (
        <EmptyHint />
      ) : (
        <ul
          className="grid gap-1"
          style={{
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateRows: `repeat(${Math.ceil(tools.length / 2)}, auto)`,
            gridAutoFlow: 'column',
          }}
        >
          {tools.map((t) => {
            const m = toolMeta[t];
            const d = toolDetails[t];
            return (
              <li key={t}>
                <Tooltip
                  side="top"
                  wide
                  content={<DeepTooltip title={t} hex={m.hex} detail={d.detail} meta={[
                    { k: 'permission', v: d.permission === 'never' ? 'never prompts' : d.permission === 'sometimes' ? 'depends on config' : 'usually prompts' },
                    ...(t === 'task' ? [{ k: 'role', v: 'native A2A primitive' }] : []),
                  ]} />}
                >
                  <div className="rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1.5 cursor-help">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="w-[74px] shrink-0 flex items-center">
                        <ToolChip tool={t} />
                      </span>
                      <span className="text-[10.5px] text-fog-400 leading-tight truncate flex-1">
                        {m.blurb}
                      </span>
                      <span className="w-[64px] shrink-0 flex items-center justify-start">
                        {t === 'task' ? (
                          <span className="font-mono text-[8.5px] uppercase tracking-widest2 text-molten">
                            A2A
                          </span>
                        ) : (
                          <span className={clsx('font-mono text-[8.5px] uppercase tracking-widest2', permissionTone(d.permission))}>
                            {permissionLabel(d.permission)}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                </Tooltip>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// -------- Events section ------------------------------------------------

export function EventsSection({ groups }: { groups: { label: string; events: EventType[] }[] }) {
  const total = groups.reduce((n, g) => n + g.events.length, 0);
  return (
    <SectionCard
      label="events"
      count={total}
      hint="EventType · SSE stream"
    >
      {groups.length === 0 ? (
        <EmptyHint />
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}
        >
          {groups.map((g) => (
            <div key={g.label} className="min-w-0">
              <div className="px-1 mb-1 flex items-baseline gap-1.5 hairline-b pb-1">
                <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
                  {g.label}
                </span>
                <span className="font-mono text-[9px] text-fog-700 tabular-nums ml-auto">
                  {g.events.length}
                </span>
              </div>
              <ul className="space-y-0.5">
                {g.events.map((e) => {
                  const d = eventDetails[e];
                  return (
                    <li key={e}>
                      <Tooltip side="top" wide content={<DeepTooltip title={e} detail={d.detail} meta={[]} />}>
                        <div className="rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1 cursor-help">
                          <code className="font-mono text-[10.5px] text-fog-200 block truncate">
                            {e}
                          </code>
                        </div>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// -------- Status section ------------------------------------------------

export function StatusSection({
  sessions,
  states,
}: {
  sessions: SessionStatusDetail[];
  states: ToolStateDetail[];
}) {
  return (
    <SectionCard
      label="status"
      count={sessions.length + states.length}
      hint="SessionStatus + ToolState"
    >
      {sessions.length + states.length === 0 ? (
        <EmptyHint />
      ) : (
        (() => {
          const cols = [
            sessions.length > 0 && {
              key: 'session.status',
              label: 'session.status',
              count: sessions.length,
              rows: sessions,
            },
            states.length > 0 && {
              key: 'tool.state',
              label: 'tool state',
              count: states.length,
              rows: states,
            },
          ].filter(Boolean) as {
            key: string;
            label: string;
            count: number;
            rows: (SessionStatusDetail | ToolStateDetail)[];
          }[];
          return (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}
            >
              {cols.map((c) => (
                <div key={c.key} className="min-w-0">
                  <div className="px-1 mb-1 flex items-baseline gap-1.5 hairline-b pb-1">
                    <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500">
                      {c.label}
                    </span>
                    <span className="font-mono text-[9px] text-fog-700 tabular-nums ml-auto">
                      {c.count}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {c.rows.map((s) => (
                      <StatusRow
                        key={s.value}
                        value={s.value}
                        hex={s.hex}
                        blurb={s.blurb}
                        transition={s.transition}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          );
        })()
      )}
    </SectionCard>
  );
}

function StatusRow({
  value,
  hex,
  blurb,
  transition,
}: {
  value: string;
  hex: string;
  blurb: string;
  transition: string;
}) {
  return (
    <li>
      <Tooltip
        side="top"
        wide
        content={<DeepTooltip title={value} hex={hex} detail={blurb} meta={[{ k: 'next', v: transition }]} />}
      >
        <div className="flex items-center gap-2 rounded bg-ink-900/40 hover:bg-ink-900/70 transition px-2 py-1 cursor-help">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: hex }}
          />
          <span className="w-[76px] shrink-0 flex items-center">
            <code
              className="font-mono text-[10.5px] uppercase tracking-widest2"
              style={{ color: hex }}
            >
              {value}
            </code>
          </span>
          <span className="text-[10.5px] text-fog-400 leading-tight truncate flex-1">
            {blurb}
          </span>
        </div>
      </Tooltip>
    </li>
  );
}

// -------- Shared tooltip + empty ----------------------------------------

function DeepTooltip({
  title,
  hex,
  detail,
  meta,
}: {
  title: string;
  hex?: string;
  detail: string;
  meta: { k: string; v: string }[];
}) {
  return (
    <div className="space-y-1.5 max-w-[300px]">
      <div className="flex items-center gap-2">
        {hex && (
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: hex }}
          />
        )}
        <code
          className="font-mono text-[11.5px] tracking-tight"
          style={{ color: hex ?? '#cfd6df' }}
        >
          {title}
        </code>
      </div>
      <div className="text-[11px] text-fog-300 leading-relaxed">{detail}</div>
      {meta.length > 0 && (
        <div className="pt-1 hairline-t space-y-0.5">
          {meta.map((r) => (
            <div key={r.k} className="flex items-baseline gap-2 font-mono text-[10.5px]">
              <span className="text-fog-700 uppercase tracking-widest2 whitespace-nowrap shrink-0">
                {r.k}
              </span>
              <span className="text-fog-400 flex-1 leading-relaxed">{r.v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="py-3 text-center font-mono text-micro text-fog-700">no matches here</div>
  );
}

export function EmptyFilter() {
  return (
    <div className="py-6 text-center">
      <div className="font-display italic text-[15px] text-fog-500">no matches</div>
      <div className="mt-1 font-mono text-micro text-fog-700">try a different query</div>
    </div>
  );
}
