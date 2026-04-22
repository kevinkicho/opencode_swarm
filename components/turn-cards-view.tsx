'use client';

// Cards view — complementary projection to the event-level timeline. Each
// card is one (user prompt → assistant reply) turn, collapsing the tool
// calls inside that turn into a compact chip row at the bottom. Useful
// when you want to read the conversation without tracking cross-lane A2A
// topology — the timeline remains the right surface for "who sent what
// to whom."
//
// Renders chronological order (oldest first, newest at bottom) so reading
// top-down matches how the agent actually worked.

import clsx from 'clsx';
import { useEffect, useRef } from 'react';

import type { TurnCard } from '@/lib/opencode/transform';
import type { Agent } from '@/lib/swarm-types';
import { Tooltip } from './ui/tooltip';
import { compact } from '@/lib/format';

const accentStripe: Record<Agent['accent'], string> = {
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

const statusGlyph: Record<TurnCard['status'], string> = {
  success: '●',
  in_progress: '◐',
  failure: '⨯',
  aborted: '⤺',
};

const statusTone: Record<TurnCard['status'], string> = {
  success: 'text-mint',
  in_progress: 'text-molten animate-pulse',
  failure: 'text-rust',
  aborted: 'text-fog-600',
};

const toolStateTone: Record<TurnCard['tools'][number]['state'], string> = {
  pending: 'text-fog-600 border-fog-700',
  running: 'text-molten border-molten/40 animate-pulse',
  completed: 'text-fog-300 border-fog-600',
  error: 'text-rust border-rust/40',
};

function fmtWallClock(tsMs: number): string {
  const d = new Date(tsMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtDuration(startMs: number, endMs?: number): string | null {
  if (!endMs) return null;
  const secs = Math.round((endMs - startMs) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function TurnCardsView({
  cards,
  agents,
  focusedId,
  onFocus,
}: {
  cards: TurnCard[];
  agents: Agent[];
  focusedId: string | null;
  onFocus: (id: string) => void;
}) {
  const agentById = new Map(agents.map((a) => [a.id, a]));
  // Index by sessionID fallback: agent.id for live sessions is the sessionID
  // itself (see toAgents). So agentById.get(sessionID) should generally hit.

  return (
    <section className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-ink-900">
      {cards.length === 0 ? (
        <div className="h-full grid place-items-center">
          <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
            no turns yet
          </div>
        </div>
      ) : (
        <ul className="flex flex-col">
          {cards.map((c) => {
            const agent = agentById.get(c.sessionID);
            const accent = agent?.accent ?? 'fog';
            return (
              <TurnCardRow
                key={c.id}
                card={c}
                accent={accent}
                agentName={agent?.name ?? c.agent}
                focused={focusedId === c.id}
                onFocus={onFocus}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TurnCardRow({
  card,
  accent,
  agentName,
  focused,
  onFocus,
}: {
  card: TurnCard;
  accent: Agent['accent'];
  agentName: string;
  focused: boolean;
  onFocus: (id: string) => void;
}) {
  const ref = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focused]);

  const dur = fmtDuration(card.startedMs, card.completedMs);

  return (
    <li
      ref={ref}
      className={clsx(
        'relative hairline-b transition-colors cursor-pointer',
        focused ? 'bg-molten/10' : 'hover:bg-ink-800/50',
      )}
      onClick={() => onFocus(card.id)}
    >
      {/* Accent stripe — agent identity */}
      <div className={clsx('absolute left-0 top-0 bottom-0 w-[2px]', accentStripe[accent])} />

      <div className="pl-3 pr-3 py-2 space-y-1.5">
        {/* Header row — dense scannable identity+time+status */}
        <div className="flex items-center gap-2 font-mono text-micro uppercase tracking-widest2">
          <span className={clsx('text-[11px] normal-case', accentText[accent])}>{agentName}</span>
          <span className="text-fog-700">·</span>
          <Tooltip content={new Date(card.startedMs).toISOString()} side="top">
            <span className="text-fog-500 tabular-nums cursor-default">
              {fmtWallClock(card.startedMs)}
            </span>
          </Tooltip>
          {dur && (
            <>
              <span className="text-fog-700">·</span>
              <span className="text-fog-600 tabular-nums">{dur}</span>
            </>
          )}
          <span className={clsx('text-[11px] leading-none', statusTone[card.status])}>
            {statusGlyph[card.status]}
          </span>
          <div className="flex-1" />
          {card.modelID && (
            <span className="text-fog-600 normal-case">{card.modelID}</span>
          )}
          {card.tokens != null && (
            <Tooltip content={`${card.tokens.toLocaleString()} total tokens`} side="top">
              <span className="text-fog-500 tabular-nums cursor-default">
                {compact(card.tokens)}
              </span>
            </Tooltip>
          )}
          {card.cost != null && card.cost > 0 && (
            <span className="text-fog-500 tabular-nums">${card.cost.toFixed(3)}</span>
          )}
        </div>

        {/* User prompt — italicized, compact, eyebrow-ish */}
        {card.userPrompt && (
          <div className="font-mono text-[11px] text-fog-500 italic leading-snug line-clamp-2 whitespace-pre-wrap">
            {card.userPrompt}
          </div>
        )}

        {/* Assistant text — the primary content */}
        {card.assistantText && (
          <div className="font-mono text-[12px] text-fog-200 leading-relaxed whitespace-pre-wrap line-clamp-8">
            {card.assistantText}
          </div>
        )}

        {/* Tool chips — flat row summarizing turn activity */}
        {card.tools.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {card.tools.map((t) => (
              <Tooltip
                key={t.id}
                content={
                  <div className="space-y-0.5 max-w-[400px]">
                    <div className="font-mono text-[10.5px] text-fog-200">{t.name}</div>
                    {t.summary && (
                      <div className="font-mono text-[10.5px] text-fog-500 leading-snug break-all">
                        {t.summary}
                      </div>
                    )}
                    <div className="font-mono text-micro uppercase tracking-widest2 text-fog-700">
                      {t.state}
                    </div>
                  </div>
                }
                side="top"
              >
                <span
                  className={clsx(
                    'inline-flex items-center h-5 px-1.5 border rounded-sm font-mono text-micro uppercase tracking-widest2 cursor-default',
                    toolStateTone[t.state],
                  )}
                >
                  {t.name}
                </span>
              </Tooltip>
            ))}
          </div>
        )}

        {/* Files touched — surfaces patch output without opening a diff */}
        {card.filesTouched.length > 0 && (
          <div className="font-mono text-micro text-fog-600 tabular-nums pt-0.5">
            <span className="uppercase tracking-widest2 text-fog-700">wrote </span>
            {card.filesTouched.length} file{card.filesTouched.length === 1 ? '' : 's'}
            <span className="text-fog-700"> · </span>
            <span className="text-fog-500">{card.filesTouched.slice(0, 3).join(' · ')}</span>
            {card.filesTouched.length > 3 && (
              <span className="text-fog-700"> +{card.filesTouched.length - 3}</span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
