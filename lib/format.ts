export function compact(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs < 1000) return Math.round(n).toString();
  if (abs < 10_000) return stripZero((n / 1000).toFixed(1)) + 'k';
  if (abs < 1_000_000) return Math.round(n / 1000) + 'k';
  if (abs < 10_000_000) return stripZero((n / 1_000_000).toFixed(1)) + 'M';
  if (abs < 1_000_000_000) return Math.round(n / 1_000_000) + 'M';
  if (abs < 10_000_000_000) return stripZero((n / 1_000_000_000).toFixed(1)) + 'B';
  return Math.round(n / 1_000_000_000) + 'B';
}

function stripZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Format elapsed ms as a short human-readable string: "3m 12s", "1h 4m", "42s"
export function fmtElapsed(ms: number): string {
  if (ms < 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}
