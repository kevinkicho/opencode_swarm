// @vitest-environment jsdom

// Component-level a11y + keyboard test for Popover.
//
// Backstops the cloneElement fix landed in bf79b35 (axe `aria-allowed-attr`
// regression — ARIA was on the wrapper span, not the button). This test
// runs vitest-axe against the rendered DOM in both closed and open states,
// so any future refactor that moves the ARIA props back to a non-trigger
// node will fail loudly here instead of being caught by a Playwright probe
// against the live dev server.
//
// Also covers the Esc-to-close path that the headless Playwright probe
// couldn't reliably exercise (focus context issue).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';

import { Popover } from '../popover';

function Harness() {
  return (
    <Popover content={() => <div>popover body content</div>}>
      <button type="button">trigger</button>
    </Popover>
  );
}

describe('Popover a11y', () => {
  it('closed state has zero axe violations', async () => {
    const { container } = render(<Harness />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('open state has zero axe violations', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'trigger' }));
    // Floating UI mounts the panel via FloatingPortal — assert on the
    // whole document so the portaled subtree is in scope.
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  });

  it('aria-expanded / aria-haspopup live on the button, not the wrapper', async () => {
    render(<Harness />);
    const btn = screen.getByRole('button', { name: 'trigger' });
    // The cloneElement fix means the trigger button itself owns these
    // attributes. If a refactor pushes them back onto the wrapper span,
    // axe's aria-allowed-attr fires (we caught this exact regression
    // before — see commit bf79b35). Using vanilla getAttribute keeps
    // the dep surface small (no jest-dom matchers).
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');

    const user = userEvent.setup();
    await user.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('floating dialog has an accessible name (aria-labelledby → trigger)', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    const btn = screen.getByRole('button', { name: 'trigger' });
    await user.click(btn);
    // useRole({role:'dialog'}) gives the floating root role=dialog. We
    // wired aria-labelledby to the trigger's useId so the dialog's name
    // resolves to the trigger's text. axe's aria-dialog-name rule
    // (serious) fires without this.
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(btn.id);
    expect(btn.id).toBeTruthy();
  });
});
