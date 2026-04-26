import { describe, expect, it } from 'vitest';
import { truncateDraftForSynthesis } from '../map-reduce';

// Synthesis-prompt overflow was the diagnosed root cause of #97 (the
// MAXTEAM-2026-04-26 map-reduce-at-teamSize-8 run that burned 10M
// tokens with 0 done). Without the per-draft cap, an 8-way concat
// of verbose mapper drafts overruns every available model's context
// and the synthesizer turn never produces output. Drift in the
// truncate cap or marker shape would silently re-open that hole.

describe('truncateDraftForSynthesis', () => {
  it('passes through short drafts unchanged', () => {
    const text = 'hello world';
    const out = truncateDraftForSynthesis(text);
    expect(out.text).toBe(text);
    expect(out.truncated).toBe(false);
  });

  it('passes through drafts at the cap unchanged', () => {
    // 80,000 chars exactly — at the boundary, should NOT be truncated.
    const text = 'a'.repeat(80_000);
    const out = truncateDraftForSynthesis(text);
    expect(out.truncated).toBe(false);
    expect(out.text.length).toBe(80_000);
  });

  it('truncates drafts above the cap', () => {
    const text = 'b'.repeat(120_000);
    const out = truncateDraftForSynthesis(text);
    expect(out.truncated).toBe(true);
    // The truncated body still has the leading 80K chars (the head),
    // followed by a marker. We don't pin the EXACT length because the
    // marker is human-readable (digits depend on the omitted count),
    // but the truncated text MUST include the marker so the
    // synthesizer can see the input was capped.
    expect(out.text).toMatch(/truncated for synthesis/);
    expect(out.text).toMatch(/40,000/); // 120K - 80K cap = 40K omitted
  });

  it('encodes the omitted-char count in the marker', () => {
    const text = 'c'.repeat(85_000);
    const out = truncateDraftForSynthesis(text);
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/5,000 additional chars/);
  });

  it('marker includes guidance to reduce teamSize', () => {
    // The synthesizer reading the prompt should see actionable
    // guidance, not just "this was cut." Pin the recommendation
    // text so a future refactor doesn't drop the hint.
    const out = truncateDraftForSynthesis('z'.repeat(200_000));
    expect(out.text).toMatch(/teamSize/);
  });
});
