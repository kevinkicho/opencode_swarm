'use client';

import clsx from 'clsx';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useFloating,
  useClick,
  useInteractions,
  useRole,
  useDismiss,
  offset,
  flip,
  shift,
  FloatingPortal,
  useTransitionStyles,
  autoUpdate,
  type Placement,
} from '@floating-ui/react';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';

function toPlacement(side: Side, align: Align): Placement {
  if (align === 'center') return side;
  return `${side}-${align}` as Placement;
}

export function Popover({
  content,
  children,
  side = 'bottom',
  align = 'center',
  wide,
  width,
  className,
}: {
  content: (close: () => void) => ReactNode;
  children: ReactElement;
  side?: Side;
  align?: Align;
  wide?: boolean;
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: toPlacement(side, align),
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context, { keyboardHandlers: false });
  const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);
  const { isMounted, styles } = useTransitionStyles(context, { duration: 150 });

  const close = useCallback(() => setOpen(false), []);

  // The trigger gets a stable id so the floating dialog can point
  // `aria-labelledby` at it — axe's `aria-dialog-name` rule requires a
  // dialog to have an accessible name, and the trigger's visible text is
  // the natural choice. Without this, the popover panel is an unnamed
  // dialog (axe-flagged: serious).
  const triggerId = useId();

  // Attach the ARIA-bearing reference props directly to the trigger
  // child (typically a <button>) instead of wrapping it in a span that
  // carries those attributes. Wrapping was triggering axe's
  // `aria-allowed-attr` (aria-expanded/aria-haspopup not valid on a
  // bare span) and adding role="button" made the violation worse —
  // nested-interactive between the role-button span and the inner
  // <button>. cloneElement merges the props onto the real trigger,
  // and the wrapper becomes presentation-only positioning.
  //
  // 2026-04-27: discovered a second class of bug — `getReferenceProps()`
  // returns an `onClick` (the popover's toggle handler), and a naive
  // spread overwrites any onClick the trigger child already has. Timeline
  // event cards (`<Popover><button onClick={() => onFocus(msg.id)}>...`)
  // had their `onFocus` silently dropped: clicking opened the popover
  // panel but the inspector drawer never got the focus signal because
  // its setter never fired. Fix: explicitly merge the trigger's existing
  // onClick with the reference-props onClick so both run.
  const refProps = getReferenceProps() as Record<string, unknown> & {
    onClick?: (e: React.MouseEvent) => void;
  };
  const childExistingProps = (isValidElement(children)
    ? (children as ReactElement<Record<string, unknown>>).props
    : {}) as Record<string, unknown> & {
    onClick?: (e: React.MouseEvent) => void;
  };
  const mergedOnClick = (e: React.MouseEvent): void => {
    refProps.onClick?.(e);
    if (!e.defaultPrevented) childExistingProps.onClick?.(e);
  };
  const childRefMerge = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        ref: refs.setReference,
        id: triggerId,
        ...refProps,
        onClick: mergedOnClick,
      } as Record<string, unknown>)
    : children;

  return (
    <>
      <span className={clsx('relative inline-flex', className)} role="presentation">
        {childRefMerge}
      </span>
      {isMounted && (
        <FloatingPortal>
          <span
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 75 }}
            aria-labelledby={triggerId}
            {...getFloatingProps()}
          >
            <span style={styles} className="block">
              <span
                className={clsx(
                  'block rounded-md bg-ink-900/95 backdrop-blur-md hairline shadow-card',
                  !width && (wide ? 'min-w-[280px]' : 'min-w-[220px]')
                )}
                style={width ? { width } : undefined}
              >
                {/* Earlier shape included `onMouseDown stopPropagation`
                    on this wrapper as defensive paranoia. Removed
                    2026-04-27 — Floating UI's `useDismiss({outsidePress})`
                    already excludes the floating tree from outside-press
                    detection, so the stopPropagation served no real
                    purpose AND it interfered with click-event sequencing
                    on anchor children: Next.js <Link> inside the popover
                    (e.g. swarm-runs-picker rows + retro link) wouldn't
                    navigate when clicked. Removing the stopPropagation
                    fixes that without affecting the popover's own
                    outside-click dismiss behavior. */}
                {content(close)}
              </span>
            </span>
          </span>
        </FloatingPortal>
      )}
    </>
  );
}
