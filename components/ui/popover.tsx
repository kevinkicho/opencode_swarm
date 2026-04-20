'use client';

import clsx from 'clsx';
import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
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

  return (
    <>
      <span
        ref={refs.setReference}
        {...getReferenceProps()}
        className={clsx('relative inline-flex', className)}
      >
        {children}
      </span>
      {isMounted && (
        <FloatingPortal>
          <span
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 75 }}
            {...getFloatingProps()}
          >
            <span style={styles} className="block">
              <span
                className={clsx(
                  'block rounded-md bg-ink-900/95 backdrop-blur-md hairline shadow-card',
                  !width && (wide ? 'min-w-[280px]' : 'min-w-[220px]')
                )}
                style={width ? { width } : undefined}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {content(close)}
              </span>
            </span>
          </span>
        </FloatingPortal>
      )}
    </>
  );
}
