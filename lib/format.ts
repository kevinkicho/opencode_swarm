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
