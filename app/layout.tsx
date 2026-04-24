import type { Metadata } from 'next';
import './globals.css';
import { ChunkErrorReload } from '@/components/chunk-error-reload';
import { ReactScanProbe } from '@/components/perf/react-scan-probe';

// Dev-phase note (2026-04-22): swapped from `next/font/google` to CSS-native
// font stacks because WSL blocks fetching fonts.gstatic.com during Next's
// build-time font pipeline, wedging the dev server's first compile for
// minutes. System fonts kill the network dependency at the cost of
// typographic identity — acceptable for a personal-use prototype. To
// restore the branded look (Instrument Serif / JetBrains Mono / Inter Tight),
// vendor the .woff2 files under `/public/fonts` and use `next/font/local`.

export const metadata: Metadata = {
  title: 'opencode - session',
  description: 'Timeline-centric webui for agentic coding sessions',
};

const SYSTEM_FONT_VARS = {
  '--font-display': 'Georgia, "Times New Roman", serif',
  '--font-mono':
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '--font-sans':
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
} as React.CSSProperties;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={SYSTEM_FONT_VARS}>
      <body className="font-sans">
        <ChunkErrorReload />
        <ReactScanProbe />
        {children}
      </body>
    </html>
  );
}
