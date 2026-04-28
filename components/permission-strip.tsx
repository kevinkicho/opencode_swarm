'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { Tooltip } from './ui/tooltip';
import type { OpencodePermissionRequest } from '@/lib/opencode/types';

// Shown above the composer when opencode has pending tool-approval requests.
// Surfaces the oldest pending request with once / always / reject actions;
// a small cycle indicator appears when multiple are queued.
export function PermissionStrip({
  pending,
  onApprove,
  onReject,
  error,
}: {
  pending: OpencodePermissionRequest[];
  onApprove: (permissionID: string, scope: 'once' | 'always') => void;
  onReject: (permissionID: string) => void;
  error: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (pending.length === 0 && !error) return null;

  if (error && pending.length === 0) {
    return (
      <div className="hairline-t bg-ink-900 px-4 h-7 flex items-center gap-2 text-[11px] font-mono text-rust">
        <span className="w-1.5 h-1.5 rounded-full bg-rust" />
        <span className="uppercase tracking-widest2 text-micro">permission error</span>
        <span className="text-fog-500 truncate">{error}</span>
      </div>
    );
  }

  const req = pending[0];
  // v1.14 Permission.pattern is `string | readonly string[] | undefined`;
  // collapse to the first display string regardless of shape.
  const pattern = Array.isArray(req.pattern)
    ? (req.pattern[0] ?? '')
    : (req.pattern ?? '');
  const act = async (fn: () => void) => {
    if (busy) return;
    setBusy(req.id);
    try {
      fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="hairline-t bg-molten/[0.04] backdrop-blur px-4 h-9 flex items-center gap-2 shrink-0">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-molten animate-pulse" />
        <span className="font-mono text-[9px] uppercase tracking-widest2 text-molten">
          await
        </span>
      </div>

      <span className="w-px h-3 bg-molten/20" />

      <span className="font-mono text-[11px] uppercase tracking-widest2 text-fog-200 shrink-0">
        {req.type}
      </span>

      {(pattern || req.title) && (
        <>
          <span className="w-px h-3 bg-ink-700" />
          <Tooltip content={req.title || pattern} side="top">
            <span className="font-mono text-[11px] text-fog-400 truncate min-w-0 flex-1">
              {pattern || req.title}
            </span>
          </Tooltip>
        </>
      )}

      {pending.length > 1 && (
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 tabular-nums shrink-0">
          1 / {pending.length}
        </span>
      )}

      <div className="flex items-center gap-1 shrink-0 ml-auto">
        <button
          onClick={() => act(() => onApprove(req.id, 'once'))}
          disabled={!!busy}
          className={clsx(
            'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition',
            'bg-ink-800 border-mint/30 text-mint hover:bg-mint/10',
            busy && 'opacity-60 cursor-wait',
          )}
        >
          once
        </button>
        <Tooltip content="approve this pattern for the rest of the session" side="top">
          <button
            onClick={() => act(() => onApprove(req.id, 'always'))}
            disabled={!!busy}
            className={clsx(
              'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition',
              'bg-mint/10 border-mint/50 text-mint hover:bg-mint/20',
              busy && 'opacity-60 cursor-wait',
            )}
          >
            always
          </button>
        </Tooltip>
        <button
          onClick={() => act(() => onReject(req.id))}
          disabled={!!busy}
          className={clsx(
            'h-6 px-2 rounded hairline font-mono text-[10px] uppercase tracking-widest2 transition',
            'bg-ink-800 border-rust/30 text-rust hover:bg-rust/10',
            busy && 'opacity-60 cursor-wait',
          )}
        >
          reject
        </button>
      </div>
    </div>
  );
}
