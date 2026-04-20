'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, type ReactNode } from 'react';
import { IconWinClose } from '../icons';

export function Drawer({
  open,
  onClose,
  children,
  width = 380,
  eyebrow,
  title,
  backdrop = false,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  eyebrow?: string;
  title?: string;
  backdrop?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {backdrop && (
            <motion.button
              aria-label="close"
              onClick={onClose}
              className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
          )}
          <motion.aside
            className="fixed right-0 top-12 bottom-7 z-50 flex flex-col bg-ink-850 hairline-l shadow-card"
            style={{ width }}
            initial={{ x: width + 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: width + 20, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
          >
            <div
              aria-hidden
              className="absolute left-0 top-0 bottom-0 w-px bg-gradient-to-b from-molten/40 via-transparent to-transparent"
            />

            {(title || eyebrow) && (
              <header className="h-11 hairline-b px-4 flex items-center gap-3 bg-ink-850/90 backdrop-blur">
                <div className="flex-1 min-w-0">
                  {eyebrow && (
                    <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                      {eyebrow}
                    </div>
                  )}
                  {title && (
                    <div className="text-[13px] text-fog-100 truncate">{title}</div>
                  )}
                </div>
                <button
                  onClick={onClose}
                  className="fluent-btn w-8 h-8 min-w-0 p-0 text-fog-400"
                  aria-label="close"
                >
                  <IconWinClose size={11} />
                </button>
              </header>
            )}

            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
