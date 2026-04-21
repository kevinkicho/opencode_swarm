'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Popover } from './ui/popover';
import { Tooltip } from './ui/tooltip';
import type { Agent } from '@/lib/swarm-types';

const accentDot: Record<Agent['accent'], string> = {
  molten: 'bg-molten',
  mint: 'bg-mint',
  iris: 'bg-iris',
  amber: 'bg-amber',
  fog: 'bg-fog-500',
};

const accentText: Record<Agent['accent'], string> = {
  molten: 'text-molten',
  mint: 'text-mint',
  iris: 'text-iris',
  amber: 'text-amber',
  fog: 'text-fog-400',
};

export type ComposerTarget =
  | { kind: 'broadcast' }
  | { kind: 'agent'; id: string };

export function SwarmComposer({
  agents,
  onSend,
  disabled = false,
  disabledReason,
}: {
  agents: Agent[];
  onSend?: (target: ComposerTarget, body: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const defaultAgent = agents[0];
  const [target, setTarget] = useState<ComposerTarget>(() =>
    defaultAgent ? { kind: 'agent', id: defaultAgent.id } : { kind: 'broadcast' },
  );
  const [body, setBody] = useState('');
  const [flash, setFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const liveCount = agents.filter(
    (a) => a.status === 'working' || a.status === 'thinking',
  ).length;
  const targetAgent =
    target.kind === 'agent' ? agents.find((a) => a.id === target.id) ?? null : null;

  // auto-grow textarea up to 4 lines
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, [body]);

  const send = useCallback(() => {
    const trimmed = body.trim();
    if (!trimmed) return;
    onSend?.(target, trimmed);
    setBody('');
    setFlash(true);
    setTimeout(() => setFlash(false), 450);
    // refocus next tick — auto-grow effect clobbers focus otherwise
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [body, onSend, target]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const broadcast = target.kind === 'broadcast';
  const canSend = !disabled && body.trim().length > 0;

  return (
    <div
      className={clsx(
        'hairline-t bg-ink-850/80 backdrop-blur px-4 py-2 transition',
        flash && 'bg-molten/5',
        disabled && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        <Popover
          side="top"
          align="start"
          width={300}
          content={(close) => (
            <TargetMenu
              agents={agents}
              target={target}
              liveCount={liveCount}
              onPick={(t) => {
                setTarget(t);
                close();
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          )}
        >
          <button
            disabled={disabled}
            className={clsx(
              'h-9 px-2.5 rounded hairline bg-ink-900 transition flex items-center gap-1.5 shrink-0',
              disabled ? 'cursor-not-allowed' : 'hover:border-molten/40',
              broadcast && !disabled && 'border-molten/40',
            )}
          >
            <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700">
              to
            </span>
            {broadcast ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-molten animate-pulse" />
                <span className="font-mono text-[11px] uppercase tracking-widest2 text-molten">
                  all live
                </span>
                <span className="font-mono text-[9.5px] text-molten/70 tabular-nums">
                  {liveCount}
                </span>
              </>
            ) : targetAgent ? (
              <>
                <span
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full',
                    accentDot[targetAgent.accent],
                  )}
                />
                <span
                  className={clsx(
                    'font-mono text-[11px] truncate max-w-[110px]',
                    accentText[targetAgent.accent],
                  )}
                >
                  {targetAgent.name}
                </span>
                {targetAgent.focus && (
                  <span className="font-mono text-[9px] tracking-wide text-fog-600 truncate max-w-[110px]">
                    {targetAgent.focus}
                  </span>
                )}
              </>
            ) : null}
            <span className="font-mono text-[9px] text-fog-700 ml-0.5">▾</span>
          </button>
        </Popover>

        <textarea
          ref={textareaRef}
          rows={1}
          value={body}
          disabled={disabled}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            disabled
              ? (disabledReason ?? 'no active run — start one from the status rail to compose')
              : broadcast
                ? `broadcast a directive to ${liveCount} live agents…`
                : targetAgent
                  ? `message ${targetAgent.name} directly…`
                  : 'compose…'
          }
          className={clsx(
            'flex-1 min-h-9 resize-none bg-ink-900 hairline rounded px-3 py-1.5 text-[13px] text-fog-100',
            'placeholder:text-fog-700 transition leading-relaxed',
            disabled ? 'cursor-not-allowed' : 'focus:outline-none focus:border-molten/40',
          )}
        />

        <Tooltip
          side="top"
          content={
            disabled
              ? (disabledReason ?? 'no active run')
              : canSend
                ? 'send'
                : 'type a message to send'
          }
          delay={200}
        >
          <button
            onClick={send}
            disabled={!canSend}
            className={clsx(
              'h-9 px-3 rounded hairline flex items-center font-mono text-micro uppercase tracking-widest2 transition shrink-0',
              canSend
                ? broadcast
                  ? 'bg-molten/15 border-molten/50 text-molten hover:bg-molten/25'
                  : 'bg-ink-800 border-fog-500/40 text-fog-200 hover:border-molten/40 hover:text-molten'
                : 'bg-ink-900 text-fog-700 cursor-not-allowed opacity-60',
            )}
          >
            {broadcast ? 'broadcast' : 'send'}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function TargetMenu({
  agents,
  target,
  liveCount,
  onPick,
}: {
  agents: Agent[];
  target: ComposerTarget;
  liveCount: number;
  onPick: (t: ComposerTarget) => void;
}) {
  const isBroadcast = target.kind === 'broadcast';
  return (
    <div className="p-1">
      <div className="px-2 pt-1.5 pb-1 font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
        broadcast
      </div>
      <button
        onClick={() => onPick({ kind: 'broadcast' })}
        className={clsx(
          'w-full px-2 py-1.5 rounded flex items-center gap-2 text-left transition',
          isBroadcast ? 'bg-molten/15' : 'hover:bg-ink-800',
        )}
      >
        <span className="font-mono text-[11px] uppercase tracking-widest2 text-molten flex-1">
          all live agents
        </span>
        <span className="font-mono text-[9.5px] text-fog-600 tabular-nums">{liveCount}</span>
      </button>

      <div className="px-2 pt-2 pb-1 mt-1 hairline-t font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
        direct
      </div>
      <ul className="space-y-0.5 max-h-[280px] overflow-y-auto">
        {agents.map((a) => {
          const active = target.kind === 'agent' && target.id === a.id;
          const live = a.status === 'working' || a.status === 'thinking';
          return (
            <li key={a.id}>
              <button
                onClick={() => onPick({ kind: 'agent', id: a.id })}
                className={clsx(
                  'w-full px-2 py-1.5 rounded flex items-center gap-2 text-left transition',
                  active ? 'bg-ink-700' : 'hover:bg-ink-800',
                )}
              >
                <span
                  className={clsx(
                    'font-mono text-[11px] truncate w-[80px] shrink-0',
                    accentText[a.accent],
                    live && 'animate-pulse',
                  )}
                >
                  {a.name}
                </span>
                <span className="font-mono text-[9.5px] tracking-wide text-fog-600 truncate flex-1 min-w-0">
                  {a.focus ?? ''}
                </span>
                <span className="ml-auto font-mono text-[9px] uppercase tracking-widest2 text-fog-700 shrink-0">
                  {a.status}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
