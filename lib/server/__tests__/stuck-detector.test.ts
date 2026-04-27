import { describe, expect, it } from 'vitest';
import {
 detectStuckDeliberation,
 STUCK_TOKEN_FLOOR,
 STUCK_AGE_FLOOR_MS,
} from '../stuck-detector';

// detectStuckDeliberation gates the stuck-run signal in the picker
// (and, downstream, the operator's decision to hard-stop). Wrong
// thresholds either spam false positives (operator stops trusting the
// signal) or under-report (operators discover hung runs only when
// they check the dashboard). Drift here directly damages user trust
// in the run-list status.

describe('detectStuckDeliberation', () => {
 it('returns not-stuck when board has any items', () => {
 expect(
 detectStuckDeliberation({
 tokensTotal: 10_000_000,
 ageMs: 60 * 60 * 1000,
 boardItemCount: 1,
 }),
 ).toEqual({ stuck: false });
 });

 it('returns not-stuck below token floor', () => {
 expect(
 detectStuckDeliberation({
 tokensTotal: STUCK_TOKEN_FLOOR - 1,
 ageMs: 60 * 60 * 1000,
 boardItemCount: 0,
 }),
 ).toEqual({ stuck: false });
 });

 it('returns not-stuck below age floor', () => {
 expect(
 detectStuckDeliberation({
 tokensTotal: 5_000_000,
 ageMs: STUCK_AGE_FLOOR_MS - 1,
 boardItemCount: 0,
 }),
 ).toEqual({ stuck: false });
 });

 it('returns stuck when all conditions cross', () => {
 const r = detectStuckDeliberation({
 tokensTotal: 3_400_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(true);
 expect(r.reason).toMatch(/3\.4M tokens/);
 expect(r.reason).toMatch(/30 min/);
 expect(r.reason).toMatch(/stuck deliberation/);
 });

 it('catches the MAXTEAM-2026-04-26 map-reduce case', () => {
 // 10.3M tokens / 0 done over ~30 min. Should fire stuck even more
 // aggressively than the case.
 const r = detectStuckDeliberation({
 tokensTotal: 10_300_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(true);
 });

 it('catches the MAXTEAM-2026-04-26 council case', () => {
 // 3.85M tokens / 0 board items / stale council at ~30 min.
 // Council legitimately produces 0 board items, but if the
 // operator has no other signal, "stuck" is the right surface.
 const r = detectStuckDeliberation({
 tokensTotal: 3_850_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(true);
 });

 it('does NOT fire on a young large run that just lacks items yet', () => {
 // First 5 minutes, even at high tokens, is startup territory.
 const r = detectStuckDeliberation({
 tokensTotal: 8_000_000,
 ageMs: 5 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(false);
 });

 it('does NOT fire on a long-running cheap run', () => {
 // 8 hours, but only 100K tokens — operator probably set a tiny
 // teamSize. Don't flag.
 const r = detectStuckDeliberation({
 tokensTotal: 100_000,
 ageMs: 8 * 60 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(false);
 });

 it('does NOT fire when even a finding row exists', () => {
 // Findings count as items; the operator has SOMETHING to read.
 const r = detectStuckDeliberation({
 tokensTotal: 5_000_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 1,
 });
 expect(r.stuck).toBe(false);
 });
});
