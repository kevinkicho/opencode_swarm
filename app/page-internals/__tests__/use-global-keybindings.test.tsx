// @vitest-environment jsdom

// Replaces the unreliable Playwright keyboard probe (#7.Q42 deeper-pass).
// In headless Chrome the global Ctrl+K / Ctrl+N chord wasn't registering
// because the page hadn't established focus context — we never got a
// real signal on whether the binding works. This test exercises the same
// hook directly: render it, dispatch the chord through user-event, and
// assert the mock openers fire. JSDOM's focus model is deterministic so
// the result is unambiguous.

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useGlobalKeybindings } from '../use-global-keybindings';
import type { PageModalState } from '../use-modal-state';

function makeModals(): PageModalState {
  return {
    flags: {
      palette: false, routing: false, history: false, spawn: false,
      glossary: false, newRun: false, provenance: false, cost: false,
    },
    openers: {
      palette: vi.fn(), togglePalette: vi.fn(), routing: vi.fn(),
      history: vi.fn(), spawn: vi.fn(), glossary: vi.fn(),
      newRun: vi.fn(), provenance: vi.fn(), cost: vi.fn(),
    },
    closers: {
      palette: vi.fn(), routing: vi.fn(), history: vi.fn(),
      spawn: vi.fn(), glossary: vi.fn(), newRun: vi.fn(),
      provenance: vi.fn(), cost: vi.fn(),
    },
  };
}

describe('useGlobalKeybindings', () => {
  it('Ctrl+K toggles the command palette', async () => {
    const modals = makeModals();
    renderHook(() => useGlobalKeybindings(modals));
    const user = userEvent.setup();

    await user.keyboard('{Control>}k{/Control}');

    expect(modals.openers.togglePalette).toHaveBeenCalledTimes(1);
    expect(modals.openers.newRun).not.toHaveBeenCalled();
  });

  it('Cmd+K (meta) also toggles palette — same handler', async () => {
    const modals = makeModals();
    renderHook(() => useGlobalKeybindings(modals));
    const user = userEvent.setup();

    await user.keyboard('{Meta>}k{/Meta}');

    expect(modals.openers.togglePalette).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+N opens the new-run modal', async () => {
    const modals = makeModals();
    renderHook(() => useGlobalKeybindings(modals));
    const user = userEvent.setup();

    await user.keyboard('{Control>}n{/Control}');

    expect(modals.openers.newRun).toHaveBeenCalledTimes(1);
    expect(modals.openers.togglePalette).not.toHaveBeenCalled();
  });

  it('plain k / n (no modifier) does nothing', async () => {
    const modals = makeModals();
    renderHook(() => useGlobalKeybindings(modals));
    const user = userEvent.setup();

    await user.keyboard('k');
    await user.keyboard('n');

    expect(modals.openers.togglePalette).not.toHaveBeenCalled();
    expect(modals.openers.newRun).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+K (other chord) does not collide', async () => {
    const modals = makeModals();
    renderHook(() => useGlobalKeybindings(modals));
    const user = userEvent.setup();

    // The hook only checks `metaKey || ctrlKey`, not shift. So this WILL
    // fire — documenting the current behavior, not asserting strictness.
    await user.keyboard('{Control>}{Shift>}k{/Shift}{/Control}');

    expect(modals.openers.togglePalette).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unmount', async () => {
    const modals = makeModals();
    const { unmount } = renderHook(() => useGlobalKeybindings(modals));
    const user = userEvent.setup();

    unmount();
    await user.keyboard('{Control>}k{/Control}');

    expect(modals.openers.togglePalette).not.toHaveBeenCalled();
  });
});
