import { describe, expect, it } from 'vitest';
import {
 detectStuckDeliberation,
 STUCK_TOKEN_FLOOR,
 STUCK_AGE_FLOOR_MS,
 STUCK_MESSAGE_FLOOR,
} from '../stuck-detector';

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
 const r = detectStuckDeliberation({
 tokensTotal: 10_300_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(true);
 });

 it('catches the MAXTEAM-2026-04-26 council case', () => {
 const r = detectStuckDeliberation({
 tokensTotal: 3_850_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(true);
 });

 it('does NOT fire on a young large run that just lacks items yet', () => {
 const r = detectStuckDeliberation({
 tokensTotal: 8_000_000,
 ageMs: 5 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(false);
 });

 it('does NOT fire on a long-running cheap run', () => {
 const r = detectStuckDeliberation({
 tokensTotal: 100_000,
 ageMs: 8 * 60 * 60 * 1000,
 boardItemCount: 0,
 });
 expect(r.stuck).toBe(false);
 });

 it('does NOT fire when even a finding row exists', () => {
 const r = detectStuckDeliberation({
 tokensTotal: 5_000_000,
 ageMs: 30 * 60 * 1000,
 boardItemCount: 1,
 });
 expect(r.stuck).toBe(false);
 });

 // Ollama zero-token fallback tests
 it('fires stuck for ollama zero-token runs with enough messages and age', () => {
   const r = detectStuckDeliberation({
     tokensTotal: 0,
     ageMs: 15 * 60 * 1000,
     boardItemCount: 0,
     messageCount: 8,
   });
   expect(r.stuck).toBe(true);
   expect(r.reason).toMatch(/zero-token provider/);
 });

 it('does NOT fire for ollama run with too few messages', () => {
   const r = detectStuckDeliberation({
     tokensTotal: 0,
     ageMs: 15 * 60 * 1000,
     boardItemCount: 0,
     messageCount: STUCK_MESSAGE_FLOOR - 1,
   });
   expect(r.stuck).toBe(false);
 });

 it('does NOT fire for young ollama run even with many messages', () => {
   const r = detectStuckDeliberation({
     tokensTotal: 0,
     ageMs: STUCK_AGE_FLOOR_MS - 1,
     boardItemCount: 0,
     messageCount: 20,
   });
   expect(r.stuck).toBe(false);
 });

 it('does NOT fire for ollama run with board items', () => {
   const r = detectStuckDeliberation({
     tokensTotal: 0,
     ageMs: 15 * 60 * 1000,
     boardItemCount: 1,
     messageCount: 20,
   });
   expect(r.stuck).toBe(false);
 });

 it('primary token gate still fires even when messageCount is low', () => {
   const r = detectStuckDeliberation({
     tokensTotal: 3_000_000,
     ageMs: 30 * 60 * 1000,
     boardItemCount: 0,
     messageCount: 0,
   });
   expect(r.stuck).toBe(true);
   expect(r.reason).toMatch(/3\.0M tokens/);
 });
});