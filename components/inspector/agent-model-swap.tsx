'use client';

// Per-agent model hot-swap row + its picker popover.
//
// ModelSwapRow renders the current model as a clickable button; the
// popover opens a tier-grouped ModelPicker that lists everything from
// /api/swarm/providers (live opencode catalog, falling back to the
// static one). Picking a model marks the row as "swap pending apply"
// — the actual session-level model swap call ships when opencode
// grows the per-session override endpoint.
//
// Lifted from agent-inspector.tsx 2026-04-28; both helpers move
// together because the picker is only used here and the row's
// Popover content lambda needs direct reference to it.

import clsx from 'clsx';
import { useState } from 'react';
import type { Agent, ModelRef, Provider } from '@/lib/swarm-types';
import { ProviderBadge } from '../provider-badge';
import { Popover } from '../ui/popover';
import { useOpencodeProviders } from '@/lib/opencode/live';

export function ModelSwapRow({ agent }: { agent: Agent }) {
  const [model, setModel] = useState<ModelRef>(agent.model);
  const swapped = model.id !== agent.model.id;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 font-mono text-micro uppercase tracking-widest2">
        <span className="text-fog-600">model</span>
        {swapped && (
          <span className="text-molten normal-case tracking-normal">
            · hot-swap pending apply
          </span>
        )}
      </div>
      <Popover
        side="bottom"
        align="start"
        width={320}
        content={(close) => (
          <ModelPicker
            current={model}
            onPick={(m) => {
              setModel(m);
              close();
            }}
          />
        )}
      >
        <button
          className={clsx(
            'w-full flex items-center gap-2 px-2 py-1.5 rounded hairline bg-ink-900 transition text-left',
            swapped
              ? 'border-molten/50 hover:border-molten'
              : 'border-ink-600 hover:border-fog-500/50',
          )}
        >
          <ProviderBadge provider={model.provider} size="sm" />
          <span className="font-mono text-[11.5px] text-fog-100 truncate flex-1">
            {model.label}
          </span>
          {model.pricing && (
            <span className="font-mono text-[9.5px] text-fog-600 tabular-nums shrink-0">
              ${model.pricing.input}/${model.pricing.output}
            </span>
          )}
          <span className="font-mono text-[9px] text-fog-600 shrink-0">▾</span>
        </button>
      </Popover>
      {swapped && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setModel(agent.model)}
            className="font-mono text-[10px] uppercase tracking-wider text-fog-600 hover:text-fog-300 transition"
          >
            revert
          </button>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-fog-600">
              swap mid-session?
            </span>
            <button
              className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-molten/15 border border-molten/40 text-molten hover:bg-molten/25 transition"
            >
              apply
            </button>
          </span>
        </div>
      )}
      <div className="font-mono text-[9.5px] text-fog-700 leading-snug">
        hot-swap updates subsequent turns — in-flight calls continue on the prior model
      </div>
    </div>
  );
}

function ModelPicker({
  current,
  onPick,
}: {
  current: ModelRef;
  onPick: (m: ModelRef) => void;
}) {
  // Live catalog from opencode's /config/providers (via /api/swarm/
  // providers). Replaces the static modelCatalog.filter() approach so
  // adding a provider in opencode.json shows up here without a code edit.
  const { byTier, source } = useOpencodeProviders();
  const groups: Array<{ provider: Provider; label: string; hint: string }> = [
    { provider: 'zen', label: 'opencode zen', hint: 'premium routing, metered per token' },
    { provider: 'ollama', label: 'ollama max', hint: 'subscription bundle, $100/mo cap' },
    { provider: 'go', label: 'opencode go', hint: 'shared go-tier quota' },
    { provider: 'byok', label: 'bring your own key', hint: 'direct provider keys' },
  ];
  return (
    <div className="p-1 max-h-[360px] overflow-y-auto">
      {source === 'fallback' && (
        <div className="px-2 py-1 mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-amber/70 hairline-b">
          static catalog · opencode unreachable
        </div>
      )}
      {groups.map((g) => {
        const rows = byTier(g.provider);
        if (rows.length === 0) return null;
        return (
          <div key={g.provider} className="mb-1">
            <div className="px-2 pt-1.5 pb-0.5 flex items-center gap-2">
              <ProviderBadge provider={g.provider} size="sm" />
              <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-500">
                {g.label}
              </span>
            </div>
            <div className="px-2 pb-1 font-mono text-[9.5px] text-fog-700">{g.hint}</div>
            <ul className="space-y-0.5">
              {rows.map((m) => {
                const active = m.id === current.id;
                return (
                  <li key={m.id}>
                    <button
                      onClick={() => onPick(m)}
                      className={clsx(
                        'w-full px-2 py-1.5 rounded flex items-center gap-2 text-left transition',
                        active ? 'bg-ink-700' : 'hover:bg-ink-800',
                      )}
                    >
                      <span className="font-mono text-[11px] text-fog-100 truncate flex-1">
                        {m.label}
                      </span>
                      {m.limitTag && (
                        <span className="font-mono text-[9px] uppercase tracking-wider text-mint/80 shrink-0">
                          {m.limitTag}
                        </span>
                      )}
                      {m.pricing && (
                        <span className="font-mono text-[10px] text-fog-600 tabular-nums shrink-0">
                          ${m.pricing.input}/${m.pricing.output}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
