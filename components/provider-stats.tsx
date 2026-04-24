'use client';

import clsx from 'clsx';
import type { Agent, Provider } from '@/lib/swarm-types';
import { useProviderStats } from '@/lib/provider-context';
import { compact } from '@/lib/format';

const providerDisplay: Record<
  Provider,
  { name: string; hint: string; dot: string; accent: string; barFull: string }
> = {
  zen: {
    name: 'opencode zen',
    hint: 'premium frontier models routed by opencode',
    dot: 'bg-molten',
    accent: 'text-molten',
    barFull: 'bg-molten/70',
  },
  go: {
    name: 'opencode go',
    hint: 'shared go-tier quota across rotating open models',
    dot: 'bg-mint',
    accent: 'text-mint',
    barFull: 'bg-mint/70',
  },
  ollama: {
    name: 'ollama max',
    hint: 'ollama.com subscription bundle — :cloud variants, flat monthly cost',
    dot: 'bg-iris',
    accent: 'text-iris',
    barFull: 'bg-iris/70',
  },
  byok: {
    name: 'bring your own key',
    hint: 'direct provider api keys, no opencode routing',
    dot: 'bg-fog-500',
    accent: 'text-fog-300',
    barFull: 'bg-fog-500/70',
  },
};

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

export function ProviderStats({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose?: () => void;
}) {
  const { agents, run, onOpenRouting } = useProviderStats();
  const display = providerDisplay[provider];
  const onThisProvider = agents.filter((a) => a.model.provider === provider);
  const totalTokens = onThisProvider.reduce((s, a) => s + a.tokensUsed, 0);
  const totalCost = onThisProvider.reduce((s, a) => s + a.costUsed, 0);

  return (
    <div className="p-3 min-w-[280px] max-w-[320px] space-y-2.5">
      <div className="flex items-center gap-2">
        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', display.dot)} />
        <span
          className={clsx(
            'font-mono text-[10.5px] uppercase tracking-widest2 shrink-0',
            display.accent,
          )}
        >
          {provider}
        </span>
        <span className="text-[11.5px] text-fog-200 truncate">{display.name}</span>
      </div>
      <div className="font-mono text-[10.5px] text-fog-500 leading-snug">{display.hint}</div>

      <div className="grid grid-cols-3 gap-2 hairline-t pt-2">
        <Stat label="tokens" value={compact(totalTokens)} />
        <Stat label="cost" value={`$${totalCost.toFixed(2)}`} />
        <Stat label="agents" value={String(onThisProvider.length)} />
      </div>

      {provider === 'zen' && (
        <div className="hairline-t pt-2 space-y-1">
          <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
            run budget
          </div>
          <div className="h-[3px] rounded-full bg-ink-800 overflow-hidden">
            <div
              className={clsx('h-full rounded-full', display.barFull)}
              style={{
                width: `${Math.min(100, Math.round((totalCost / run.budgetCap) * 100))}%`,
              }}
            />
          </div>
          <div className="flex items-center font-mono text-[10px] text-fog-600 tabular-nums">
            <span>
              ${totalCost.toFixed(2)} / ${run.budgetCap.toFixed(2)}
            </span>
            <span className="ml-auto text-fog-700">metered per token</span>
          </div>
        </div>
      )}

      {onThisProvider.length > 0 && (
        <div className="hairline-t pt-2 space-y-1">
          <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
            agents on this provider
          </div>
          <ul className="space-y-0.5">
            {onThisProvider.map((a) => (
              <li
                key={a.id}
                className="flex items-center gap-2 font-mono text-[10.5px] tabular-nums"
              >
                <span className={clsx('w-1 h-1 rounded-full shrink-0', accentDot[a.accent])} />
                <span
                  className={clsx(
                    'truncate w-[80px] shrink-0 normal-case',
                    accentText[a.accent],
                  )}
                >
                  {a.name}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 shrink-0 truncate">
                  {a.model.label}
                </span>
                <span className="ml-auto text-fog-600 shrink-0">{compact(a.tokensUsed)}</span>
                <span className="text-fog-600 shrink-0 w-10 text-right">
                  ${a.costUsed.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="hairline-t pt-2">
        <button
          onClick={() => {
            onOpenRouting();
            onClose?.();
          }}
          className="font-mono text-[10px] uppercase tracking-wider text-fog-400 hover:text-molten transition"
        >
          routing rules →
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600">
        {label}
      </div>
      <div className="font-mono text-[12px] text-fog-100 tabular-nums">{value}</div>
    </div>
  );
}
