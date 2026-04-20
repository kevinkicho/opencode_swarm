'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, type ReactNode } from 'react';
import { IconWinClose } from '../icons';
import { Tooltip } from './tooltip';

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  eyebrowHint,
  children,
  width = 'max-w-xl',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  eyebrowHint?: ReactNode;
  children: ReactNode;
  width?: string;
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
        <motion.div
          className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            aria-label="close"
            onClick={onClose}
            className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm"
          />
          <motion.div
            className={`relative w-full ${width} max-h-[84vh] flex flex-col bg-ink-800 rounded-lg hairline shadow-card overflow-hidden`}
            initial={{ y: -12, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -6, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-molten/40 to-transparent z-10" />
            <header className="px-5 py-4 hairline-b flex items-center gap-3 shrink-0">
              <div>
                {eyebrow &&
                  (eyebrowHint ? (
                    <Tooltip content={eyebrowHint} side="bottom" align="start" wide>
                      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-0.5 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px] hover:text-fog-300 transition">
                        {eyebrow}
                      </span>
                    </Tooltip>
                  ) : (
                    <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-0.5">
                      {eyebrow}
                    </div>
                  ))}
                <h2 className="font-display italic text-[20px] text-fog-100 leading-none mt-0.5">
                  {title}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="fluent-btn w-8 h-8 min-w-0 p-0 ml-auto text-fog-400"
                aria-label="close"
              >
                <IconWinClose size={11} />
              </button>
            </header>
            <div className="p-5 flex-1 min-h-0 overflow-y-auto">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
