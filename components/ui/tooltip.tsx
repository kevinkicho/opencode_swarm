'use client';

import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import {
  useFloating,
  useHover,
  useInteractions,
  useRole,
  useDismiss,
  offset,
  flip,
  shift,
  FloatingPortal,
  useTransitionStyles,
  autoUpdate,
  safePolygon,
  type Placement,
} from '@floating-ui/react';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';

function toPlacement(side: Side, align: Align): Placement {
  if (align === 'center') return side;
  return `${side}-${align}` as Placement;
}

export function Tooltip({
  content,
  children,
  side = 'bottom',
  align = 'center',
  delay = 120,
  className,
  wide,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  align?: Align;
  delay?: number;
  className?: string;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: toPlacement(side, align),
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    delay: { open: delay, close: 0 },
    mouseOnly: true,
    handleClose: safePolygon({ blockPointerEvents: false }),
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, dismiss, role]);
  const { isMounted, styles } = useTransitionStyles(context, {
    duration: 150,
    initial: { opacity: 0, transform: 'translateY(2px)' },
  });

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
            style={{ ...floatingStyles, zIndex: 80, pointerEvents: 'none' }}
            {...getFloatingProps()}
          >
            <span style={styles} className="block">
              <span
                className={clsx(
                  'block rounded-md bg-ink-900/95 backdrop-blur-md hairline px-2.5 py-1.5 shadow-card',
                  wide ? 'min-w-[240px] max-w-[320px]' : 'whitespace-nowrap'
                )}
              >
                {typeof content === 'string' ? (
                  <span className="font-mono text-[11px] text-fog-200">{content}</span>
                ) : (
                  content
                )}
              </span>
            </span>
          </span>
        </FloatingPortal>
      )}
    </>
  );
}
