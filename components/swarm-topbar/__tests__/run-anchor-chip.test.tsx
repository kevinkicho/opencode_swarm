// @vitest-environment jsdom

// "Chip flip" test for RunAnchorChip — the always-visible run-status
// indicator in the topbar.
//
// The server-side derivation tests already cover the *decision* (when a
// session crosses ZOMBIE_THRESHOLD_MS, it flips from 'live' to 'stale').
// This test covers the *display*: given a status prop, the chip shows
// the right dot color, animation, and label. So even if the server
// derivation changes, we know the chip will render the resulting status
// correctly.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunAnchorChip } from '../run-anchor-chip';
import type { SwarmRunMeta } from '@/lib/swarm-run-types';

const meta: SwarmRunMeta = {
  swarmRunID: 'run_test',
  pattern: 'none',
  createdAt: 1_700_000_000_000,
  workspace: '/tmp/x',
  sessionIDs: ['ses_a'],
};

describe('RunAnchorChip — status flip', () => {
  it('live status → mint pulsing dot', () => {
    render(<RunAnchorChip meta={meta} status="live" />);
    const dot = screen.getByLabelText('status: live');
    // Live runs pulse mint (animate-pulse) — visible cue that compute
    // is currently attached and producing.
    expect(dot.className).toContain('bg-mint');
    expect(dot.className).toContain('animate-pulse');
  });

  it('idle status → mint solid (no pulse)', () => {
    render(<RunAnchorChip meta={meta} status="idle" />);
    const dot = screen.getByLabelText('status: idle');
    expect(dot.className).toContain('bg-mint');
    expect(dot.className).not.toContain('animate-pulse');
  });

  it('stale status → fog gray (the zombie-flip target)', () => {
    // The server derivation flips a session from 'live' to 'stale' when
    // it crosses ZOMBIE_THRESHOLD_MS without progress. THIS is the visual
    // outcome of that flip — gray, no pulse.
    render(<RunAnchorChip meta={meta} status="stale" />);
    const dot = screen.getByLabelText('status: stale');
    expect(dot.className).toContain('bg-fog-500');
    expect(dot.className).not.toContain('animate-pulse');
    expect(dot.className).not.toContain('bg-mint');
  });

  it('error status → rust dot', () => {
    render(<RunAnchorChip meta={meta} status="error" />);
    const dot = screen.getByLabelText('status: error');
    expect(dot.className).toContain('bg-rust');
  });

  it('null status → unknown label', () => {
    // Pre-derivation state: backend returned no status row yet. The chip
    // must still render (no crash), and the dot falls back to fog-700.
    render(<RunAnchorChip meta={meta} status={null} />);
    const dot = screen.getByLabelText('status: unknown');
    expect(dot.className).toContain('bg-fog-700');
  });

  it('stale={true} (backend unreachable) overrides the dot to gray', () => {
    // Different from status='stale': here the backend itself is offline,
    // and whatever status we cached pre-disconnect is dimmed. The button
    // gets opacity-50 + grayscale, and the dot falls back to bg-fog-700
    // even when status='live' was last known.
    render(<RunAnchorChip meta={meta} status="live" stale={true} />);
    const dot = screen.getByLabelText('status: live');
    // The label-aria comes from the status prop, but the dot color
    // overrides to fog-700 because the backend is unreachable.
    expect(dot.className).toContain('bg-fog-700');
    expect(dot.className).not.toContain('animate-pulse');
  });

  it('label text matches the visible status word', () => {
    const { rerender } = render(<RunAnchorChip meta={meta} status="live" />);
    expect(screen.getByText('live')).toBeTruthy();

    rerender(<RunAnchorChip meta={meta} status="stale" />);
    expect(screen.getByText('stale')).toBeTruthy();

    rerender(<RunAnchorChip meta={meta} status="error" />);
    expect(screen.getByText('error')).toBeTruthy();
  });
});
