'use client';

// Collapsible curl-recipe reference for API users.
//
// Default closed so it doesn't compete with the form; one-click expand
// shows every pattern's POST body with copy affordances. Lifted from
// new-run-modal.tsx 2026-04-28 — pure render with one local clipboard
// effect. Modal owns the open/closed state so the user's expansion
// preference doesn't reset on a child re-render.

import clsx from 'clsx';
import { useState } from 'react';
import { patternMeta, patternAccentText } from '@/lib/swarm-patterns';
import type { SwarmPattern } from '@/lib/swarm-types';
import { API_RECIPES } from './helpers';

export function ApiRecipesSection({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const [copiedPattern, setCopiedPattern] = useState<SwarmPattern | null>(null);

  const copyRecipe = async (p: SwarmPattern, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedPattern(p);
      setTimeout(() => setCopiedPattern((cur) => (cur === p ? null : cur)), 1200);
    } catch {
      // Clipboard blocked (e.g. non-secure context) — no-op; user can still
      // drag-select. Prototype doesn't warrant a fallback prompt.
    }
  };

  return (
    <div className="mt-4 rounded-md hairline bg-ink-900/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full h-7 px-3 flex items-center gap-2 text-left hover:bg-ink-900/60 transition"
        aria-expanded={open}
      >
        <span
          className={clsx(
            'font-mono text-[10px] leading-none text-fog-500 transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        >
          ▸
        </span>
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
          api recipes
        </span>
        <span className="font-mono text-[10px] text-fog-700 ml-auto">
          {open
            ? 'click any pattern to copy its curl body'
            : `${API_RECIPES.length} patterns · click to expand`}
        </span>
      </button>
      {open && (
        <div className="hairline-t divide-y divide-ink-800">
          {API_RECIPES.map((recipe) => {
            const meta = patternMeta[recipe.pattern];
            const isCopied = copiedPattern === recipe.pattern;
            return (
              <div key={recipe.pattern} className="px-3 py-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <span
                    className={clsx(
                      'font-mono text-[10px] uppercase tracking-widest2 shrink-0',
                      patternAccentText[meta.accent],
                    )}
                  >
                    {recipe.pattern}
                  </span>
                  <span className="font-mono text-[10px] text-fog-600 truncate">
                    — {recipe.hint}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyRecipe(recipe.pattern, recipe.body)}
                    className={clsx(
                      'ml-auto h-5 px-1.5 rounded font-mono text-[9px] uppercase tracking-widest2 border transition shrink-0',
                      isCopied
                        ? 'bg-mint/15 text-mint border-mint/30'
                        : 'bg-ink-900 text-fog-500 border-ink-700 hover:text-fog-200 hover:border-ink-500',
                    )}
                  >
                    {isCopied ? 'copied ✓' : 'copy'}
                  </button>
                </div>
                <pre className="font-mono text-[10.5px] text-fog-300 leading-snug whitespace-pre-wrap break-all bg-ink-900/60 rounded px-2 py-1.5 border border-ink-800">
                  {recipe.body}
                </pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
