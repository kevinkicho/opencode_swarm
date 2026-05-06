'use client';

import clsx from 'clsx';
import { usePlayback } from '@/lib/playback-context';

const SPEEDS = [1, 2, 4, 8] as const;

export function PlaybackControls() {
  const { clockSec, playing, speed, runDuration, setClockSec, setPlaying, setSpeed, restart } = usePlayback();

  const fmtTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progress = runDuration > 0 ? clockSec / runDuration : 0;

  return (
    <div className="flex items-center gap-2 h-6 px-2 bg-ink-850/80 backdrop-blur rounded-sm hairline select-none">
      <button
        type="button"
        onClick={() => {
          if (clockSec >= runDuration) restart();
          else setPlaying(!playing);
        }}
        className="shrink-0 w-4 h-4 grid place-items-center rounded-sm font-mono text-[10px] text-fog-300 hover:text-molten cursor-pointer transition"
        title={playing ? 'pause' : 'play'}
      >
        {playing ? '⏸' : '▶'}
      </button>

      <span className="shrink-0 font-mono text-[9px] tabular-nums text-fog-500 w-8 text-right">
        {fmtTime(clockSec)}
      </span>

      <input
        type="range"
        min={0}
        max={runDuration || 1}
        step={0.5}
        value={clockSec}
        onChange={(e) => {
          setClockSec(parseFloat(e.target.value));
          if (playing) setPlaying(false);
        }}
        className="flex-1 min-w-[60px] max-w-[120px] h-1 appearance-none bg-ink-700 rounded-full cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-molten"
      />

      <span className="shrink-0 font-mono text-[9px] tabular-nums text-fog-700 w-8">
        {fmtTime(runDuration)}
      </span>

      <div className="shrink-0 flex items-center gap-0.5">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            className={clsx(
              'h-4 px-1 rounded-sm font-mono text-[8px] tabular-nums cursor-pointer transition',
              speed === s
                ? 'bg-molten/15 text-molten'
                : 'text-fog-600 hover:text-fog-300',
            )}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}