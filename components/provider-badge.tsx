'use client';

import clsx from 'clsx';
import type { Provider } from '@/lib/swarm-types';
import { Popover } from './ui/popover';
import { ProviderStats } from './provider-stats';

const providerStyle: Record<Provider, string> = {
  zen: 'bg-molten/10 text-molten border-molten/25',
  go: 'bg-mint/10 text-mint border-mint/25',
  ollama: 'bg-iris/10 text-iris border-iris/25',
  byok: 'bg-ink-700 text-fog-300 border-ink-500',
};

export function ProviderBadge({
  provider,
  label,
  size = 'md',
  clickable = false,
}: {
  provider: Provider;
  label?: string;
  size?: 'sm' | 'md';
  clickable?: boolean;
}) {
  const chip = clsx(
    'inline-flex items-center border rounded-[3px] font-mono tracking-wider uppercase',
    size === 'sm' ? 'h-4 px-1.5 text-[9px]' : 'h-5 px-1.5 text-micro'
  );

  const badge = (
    <span className="inline-flex items-center gap-1 align-middle">
      <span className={clsx(chip, providerStyle[provider])}>{provider}</span>
      {label && (
        <span
          className={clsx(
            chip,
            'border-ink-500 bg-ink-800 text-fog-300 normal-case tracking-normal'
          )}
        >
          {label}
        </span>
      )}
    </span>
  );

  if (!clickable) return badge;

  return (
    <span
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="inline-flex"
    >
      <Popover
        side="bottom"
        align="start"
        className="cursor-pointer hover:brightness-125 transition"
        content={(close) => <ProviderStats provider={provider} onClose={close} />}
      >
        {badge}
      </Popover>
    </span>
  );
}
