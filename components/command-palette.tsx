'use client';

import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { motion, AnimatePresence } from 'framer-motion';
import type { TimelineNode } from '@/lib/types';
import type { ToolName } from '@/lib/swarm-types';
import { ToolChip } from './part-chip';

interface CommandItem {
  id: string;
  label: string;
  hint: string;
  group: string;
  node: TimelineNode;
}

// Action items are palette entries that *do* something instead of jumping
// to a timeline node. They share the same visual slot but route through
// `onSelect` rather than `onJump`. Kept as a distinct shape so TypeScript
// can prevent us from accidentally passing an action to the jump path.
export interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  group: string;
  onSelect: () => void;
  tone?: 'default' | 'molten' | 'iris';
}

const kindChip: Record<
  Exclude<TimelineNode['kind'], 'tool'>,
  { label: string; hex: string }
> = {
  user: { label: 'user', hex: '#cfd6df' },
  assistant: { label: 'text', hex: '#cfd6df' },
  thinking: { label: 'reasoning', hex: '#c084fc' },
  agent: { label: 'subtask', hex: '#ff7a3d' },
  milestone: { label: 'step', hex: '#7d8798' },
  decision: { label: 'decision', hex: '#ff7a3d' },
};

function ActionChip({ tone }: { tone: NonNullable<PaletteAction['tone']> }) {
  const palette =
    tone === 'molten'
      ? { color: '#ff7a3d', border: '#ff7a3d55' }
      : tone === 'iris'
        ? { color: '#c084fc', border: '#c084fc55' }
        : { color: '#cfd6df', border: '#cfd6df55' };
  return (
    <span
      className="inline-flex items-center h-4 px-1.5 border rounded-[3px] font-mono text-[9px] uppercase tracking-wider bg-ink-900/60 shrink-0"
      style={{ color: palette.color, borderColor: palette.border }}
    >
      action
    </span>
  );
}

function PaletteChip({ item }: { item: CommandItem }) {
  const n = item.node;
  if (n.status === 'error') {
    return (
      <span className="inline-flex items-center h-4 px-1.5 border rounded-[3px] font-mono text-[9px] uppercase tracking-wider bg-ink-900/60 text-rust border-rust/40 shrink-0">
        error
      </span>
    );
  }
  if (n.kind === 'tool' && n.toolKind) {
    return <ToolChip tool={n.toolKind as ToolName} size="sm" />;
  }
  const c = kindChip[n.kind as Exclude<TimelineNode['kind'], 'tool'>];
  return (
    <span
      className="inline-flex items-center h-4 px-1.5 border rounded-[3px] font-mono text-[9px] uppercase tracking-wider bg-ink-900/60 shrink-0"
      style={{ color: c.hex, borderColor: `${c.hex}55` }}
    >
      {c.label}
    </span>
  );
}

export function CommandPalette({
  open,
  onClose,
  nodes,
  onJump,
  actions = [],
}: {
  open: boolean;
  onClose: () => void;
  nodes: TimelineNode[];
  onJump: (id: string) => void;
  actions?: PaletteAction[];
}) {
  const [q, setQ] = useState('');

  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  // Palette is currently jump-only. The `actions` group ( branch / detach /
  // compact ) was removed in April 2026 — each was an unwired placeholder and
  // selecting them fell through to `onClose()` with no effect. Reintroduce as
  // `CommandItem[]` here once they're wired to real opencode calls
  // (`session.children` + `session.revert` for branch; `session.summarize`
  // for compact — see DESIGN.md §9).
  const items = useMemo<CommandItem[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        group: 'jump to',
        label: n.title + (n.subtitle ? ` ${n.subtitle}` : ''),
        hint: n.timestamp,
        node: n,
      })),
    [nodes]
  );

  const grouped = useMemo(() => {
    const m = new Map<string, CommandItem[]>();
    for (const i of items) {
      const arr = m.get(i.group) ?? [];
      arr.push(i);
      m.set(i.group, arr);
    }
    return Array.from(m.entries());
  }, [items]);

  const groupedActions = useMemo(() => {
    const m = new Map<string, PaletteAction[]>();
    for (const a of actions) {
      const arr = m.get(a.group) ?? [];
      arr.push(a);
      m.set(a.group, arr);
    }
    return Array.from(m.entries());
  }, [actions]);

  const select = (item: CommandItem) => {
    onJump(item.node.id);
    onClose();
  };

  const selectAction = (action: PaletteAction) => {
    action.onSelect();
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
            onClick={onClose}
            aria-label="close"
          />

          <motion.div
            className="relative w-full max-w-xl bg-ink-800 rounded-lg hairline shadow-card overflow-hidden"
            initial={{ y: -14, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -6, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-molten/40 to-transparent" />

            <Command
              label="command palette"
              loop
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
              }}
            >
              <div className="flex items-center gap-3 px-4 h-12 hairline-b">
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 shrink-0">
                  find
                </span>
                <Command.Input
                  value={q}
                  onValueChange={setQ}
                  autoFocus
                  placeholder="jump to a node — by title, agent, tool, or file…"
                  className="flex-1 bg-transparent text-[14px] text-fog-100 placeholder:text-fog-600 focus:outline-none"
                />
              </div>

              <Command.List className="max-h-[50vh] overflow-y-auto py-1">
                <Command.Empty className="py-10 text-center">
                  <div className="font-display italic text-[18px] text-fog-600">no matches</div>
                  <div className="font-mono text-micro text-fog-700 mt-1">
                    try a tool name, an agent, or a file path
                  </div>
                </Command.Empty>

                {groupedActions.map(([group, groupActions]) => (
                  <Command.Group
                    key={`action:${group}`}
                    heading={
                      <span className="block px-4 py-1 font-mono text-micro uppercase tracking-widest2 text-fog-700 text-center">
                        {group}
                      </span>
                    }
                  >
                    {groupActions.map((action) => (
                      <Command.Item
                        key={action.id}
                        value={`${action.group} ${action.label}`}
                        onSelect={() => selectAction(action)}
                        className={clsx(
                          'w-full grid items-center gap-3 px-4 h-9 text-left transition cursor-pointer relative',
                          'data-[selected=true]:bg-ink-700',
                          'aria-selected:bg-ink-700'
                        )}
                        style={{ gridTemplateColumns: '84px minmax(0, 1fr) 140px' }}
                      >
                        <span className="flex items-center">
                          <ActionChip tone={action.tone ?? 'default'} />
                        </span>
                        <span
                          className={clsx(
                            'truncate text-[13px] min-w-0',
                            action.tone === 'molten'
                              ? 'text-molten'
                              : action.tone === 'iris'
                                ? 'text-iris'
                                : 'text-fog-200'
                          )}
                        >
                          {action.label}
                        </span>
                        <span className="font-mono text-micro text-fog-600 tabular-nums text-right">
                          {action.hint}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}

                {grouped.map(([group, groupItems]) => (
                  <Command.Group
                    key={group}
                    heading={
                      <span className="block px-4 py-1 font-mono text-micro uppercase tracking-widest2 text-fog-700 text-center">
                        {group}
                      </span>
                    }
                  >
                    {groupItems.map((item) => (
                      <Command.Item
                        key={item.id}
                        value={`${item.group} ${item.label}`}
                        onSelect={() => select(item)}
                        className={clsx(
                          'w-full grid items-center gap-3 px-4 h-9 text-left transition cursor-pointer relative',
                          'data-[selected=true]:bg-ink-700',
                          'aria-selected:bg-ink-700'
                        )}
                        style={{ gridTemplateColumns: '84px minmax(0, 1fr) 140px' }}
                      >
                        <span className="flex items-center">
                          <PaletteChip item={item} />
                        </span>
                        <span className="truncate text-[13px] text-fog-200 min-w-0">
                          {item.label}
                        </span>
                        <span className="font-mono text-micro text-fog-600 tabular-nums text-right">
                          {item.hint}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>

              <CountFooter />
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CountFooter() {
  return (
    <div className="hairline-t px-4 h-8 flex items-center bg-ink-850 font-mono text-micro text-fog-700">
      <span className="ml-auto font-mono text-micro text-fog-700">esc to close</span>
    </div>
  );
}
