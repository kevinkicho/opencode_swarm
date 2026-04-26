'use client';

import { useMemo, useState } from 'react';
import { Modal } from './ui/modal';
import { partOrder, partMeta, toolMeta, toolOrder } from '@/lib/part-taxonomy';
import {
  DOCS_ROOT,
  SDK_TYPES_URL,
  eventDetails,
  eventGroups,
  glossaryPartOrder,
  glossaryToolOrder,
  partDetails,
  sessionStatuses,
  toolDetails,
  toolStates,
} from './glossary/data';
import {
  EmptyFilter,
  EventsSection,
  PartsSection,
  StatusSection,
  ToolsSection,
} from './glossary/sections';

// Glossary modal — opencode SDK vocabulary reference. Data tables live
// in glossary/data.ts; visual subcomponents (sections, status rows,
// tooltip) live in glossary/sections.tsx. This file owns just the
// modal shell + filter state + composition (extracted #108).

export function GlossaryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]) =>
    !q || fields.some((f) => f?.toLowerCase().includes(q));

  const filteredParts = useMemo(
    () =>
      glossaryPartOrder.filter((p) =>
        matches(p, partMeta[p].label, partMeta[p].blurb, partDetails[p].detail),
      ),
    [q],
  );
  const filteredTools = useMemo(
    () =>
      glossaryToolOrder.filter((t) =>
        matches(t, toolMeta[t].label, toolMeta[t].blurb, toolDetails[t].detail),
      ),
    [q],
  );
  const filteredEventGroups = useMemo(
    () =>
      eventGroups
        .map((g) => ({
          ...g,
          events: g.events.filter((e) => matches(e, g.label, eventDetails[e].detail)),
        }))
        .filter((g) => g.events.length),
    [q],
  );
  const filteredSessions = useMemo(
    () => sessionStatuses.filter((s) => matches(s.value, s.blurb, s.transition)),
    [q],
  );
  const filteredToolStates = useMemo(
    () => toolStates.filter((s) => matches(s.value, s.blurb, s.transition)),
    [q],
  );

  const eventCount = filteredEventGroups.reduce((n, g) => n + g.events.length, 0);
  const totalMatches =
    filteredParts.length +
    filteredTools.length +
    eventCount +
    filteredSessions.length +
    filteredToolStates.length;

  return (
    <Modal open={open} onClose={onClose} eyebrow="reference" title="opencode vocabulary" width="max-w-[1400px]">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by name or description"
              className="w-full h-8 pl-8 pr-3 rounded bg-ink-900 hairline text-[12.5px] text-fog-100 placeholder:text-fog-700 focus:outline-none focus:border-molten/40 transition font-mono"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-micro text-fog-700">
              /
            </span>
          </div>
          <span className="font-mono text-micro text-fog-700 tabular-nums px-2">
            {q
              ? `${totalMatches} match${totalMatches === 1 ? '' : 'es'}`
              : `${partOrder.length + toolOrder.length + eventGroups.reduce((n, g) => n + g.events.length, 0) + sessionStatuses.length + toolStates.length} entries`}
          </span>
          <a
            href={DOCS_ROOT}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-micro uppercase tracking-wider text-fog-600 hover:text-molten transition h-8 px-3 rounded hairline bg-ink-900 flex items-center"
          >
            docs
          </a>
          <a
            href={SDK_TYPES_URL}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-micro uppercase tracking-wider text-fog-600 hover:text-molten transition h-8 px-3 rounded hairline bg-ink-900 flex items-center"
          >
            types.gen
          </a>
        </div>

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}
        >
          <PartsSection parts={filteredParts} />
          <ToolsSection tools={filteredTools} />
          <EventsSection groups={filteredEventGroups} />
          <StatusSection sessions={filteredSessions} states={filteredToolStates} />
        </div>

        {totalMatches === 0 && <EmptyFilter />}

        <footer className="pt-2 hairline-t font-mono text-micro text-fog-700 leading-relaxed">
          strings from <span className="text-fog-400">packages/sdk/js/src/gen/types.gen.ts</span> ·
          descriptions are this prototype's learning aid, not quotes from opencode docs · hover any row for
          more detail
        </footer>
      </div>
    </Modal>
  );
}
