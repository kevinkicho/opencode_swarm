'use client';

import { useState } from 'react';
import { IconWinMinimize, IconWinMaximize, IconWinRestore, IconWinClose } from '../icons';

export function CaptionButtons() {
  const [maximized, setMaximized] = useState(true);

  return (
    <div className="flex h-full shrink-0 select-none" aria-label="window controls">
      <button
        type="button"
        className="caption-btn"
        aria-label="minimize"
        onClick={() => {
          /* noop in browser */
        }}
      >
        <IconWinMinimize size={10} />
      </button>
      <button
        type="button"
        className="caption-btn"
        aria-label={maximized ? 'restore' : 'maximize'}
        onClick={() => setMaximized((v) => !v)}
      >
        {maximized ? <IconWinRestore size={10} /> : <IconWinMaximize size={10} />}
      </button>
      <button
        type="button"
        className="caption-btn close"
        aria-label="close"
        onClick={() => {
          /* noop in browser */
        }}
      >
        <IconWinClose size={10} />
      </button>
    </div>
  );
}
