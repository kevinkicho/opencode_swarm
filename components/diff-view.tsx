'use client';

import clsx from 'clsx';
import type { DiffData } from '@/lib/types';

export function DiffView({ diff }: { diff: DiffData }) {
  return (
    <div className="rounded-md bg-ink-900 hairline overflow-hidden">
      <div className="flex items-center gap-3 px-3 h-8 hairline-b bg-ink-850/60">
        <span className="font-mono text-2xs text-fog-300 truncate flex-1">{diff.file}</span>
        <span className="font-mono text-micro text-mint">+{diff.additions}</span>
        <span className="font-mono text-micro text-rust">-{diff.deletions}</span>
      </div>

      <div className="code-scroll overflow-x-auto">
        {diff.hunks.map((hunk, hi) => (
          <div key={hi} className="py-1">
            <div className="px-3 py-0.5 font-mono text-micro text-fog-700 bg-ink-850/40">
              {hunk.header}
            </div>
            <pre className="font-mono text-[11.5px] leading-[1.55]">
              {hunk.lines.map((line, i) => (
                <div
                  key={i}
                  className={clsx(
                    'flex items-start',
                    line.type === 'add' && 'diff-add',
                    line.type === 'remove' && 'diff-remove',
                    line.type === 'context' && 'diff-context'
                  )}
                >
                  <span className="shrink-0 w-10 text-right pr-2 text-fog-800 select-none">
                    {line.num}
                  </span>
                  <span
                    className={clsx(
                      'shrink-0 w-4 text-center select-none',
                      line.type === 'add' && 'text-mint',
                      line.type === 'remove' && 'text-rust',
                      line.type === 'context' && 'text-fog-800'
                    )}
                  >
                    {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                  </span>
                  <span
                    className={clsx(
                      'whitespace-pre pr-4',
                      line.type === 'add' && 'text-fog-100',
                      line.type === 'remove' && 'text-fog-400',
                      line.type === 'context' && 'text-fog-500'
                    )}
                  >
                    {line.text}
                  </span>
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
