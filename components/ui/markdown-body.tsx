'use client';

// Inline markdown renderer for assistant message bodies. Phase 5.2 of
// react-markdown so headings, lists, code fences, and links render
// inside the inspector / event panel.
//
// Boundary decisions:
//   - GFM (tables, strikethrough, task lists, autolinks) — opted-in
//     because assistant text frequently uses these.
//   - No raw HTML (`disallowedElements` empty + no rehype-raw). Trust
//     boundary: assistant content can be model-generated, so a stray
//     `<script>` shouldn't survive the pipeline. react-markdown's
//     default already escapes; we double up by not enabling rehype-raw.
//   - Custom components keep the dense-factory aesthetic: monospace
//     code, hairline-b for hr, mint accent for links, fog tones for
//     headings (no large jumps — this is INSPECTOR text, not page
//     copy), pre-wrap on code blocks.
//   - `style.fontFamily` of inline code stays mono so `inline_code` in
//     a paragraph reads as code without being a different size.
//
// Use anywhere a body-of-text was previously rendered as
// whitespace-pre-wrap. Drop-in: pass `text` prop, the component
// handles the rest.

import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { stripProtocolTokens } from '@/lib/text-sanitize';

interface MarkdownBodyProps {
  text: string;
  // Default 'fog-200' for the inspector body. Override with 'fog-300'
  // for muted contexts (transcript previews) or 'fog-100' for
  // emphasized contexts (selected message).
  tone?: 'fog-100' | 'fog-200' | 'fog-300';
  // Optional className passthrough — the wrapper div already carries
  // `prose-tight` (defined in globals.css? — fallback inline below);
  // additions go on top.
  className?: string;
}

export function MarkdownBody({
  text,
  tone = 'fog-200',
  className,
}: MarkdownBodyProps) {
  const toneClass =
    tone === 'fog-100'
      ? 'text-fog-100'
      : tone === 'fog-300'
        ? 'text-fog-300'
        : 'text-fog-200';
  return (
    <div
      className={clsx(
        'text-[11.5px] leading-snug',
        toneClass,
        // Default font is the page sans; markdown body inherits.
        // Inline overrides per-element below for code / pre.
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              className="text-[13px] font-display italic text-fog-100 mt-2 mb-1 leading-tight"
              {...props}
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              className="text-[12.5px] font-display italic text-fog-100 mt-2 mb-1 leading-tight"
              {...props}
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              className="text-[12px] font-display italic text-fog-100 mt-1.5 mb-0.5 leading-tight"
              {...props}
            >
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4
              className="font-mono text-micro uppercase tracking-widest2 text-fog-300 mt-1.5 mb-0.5"
              {...props}
            >
              {children}
            </h4>
          ),
          p: ({ children, ...props }) => (
            <p className="my-1 leading-snug" {...props}>
              {children}
            </p>
          ),
          ul: ({ children, ...props }) => (
            <ul className="list-disc pl-4 my-1 space-y-0.5 marker:text-fog-700" {...props}>
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol className="list-decimal pl-4 my-1 space-y-0.5 marker:text-fog-700 tabular-nums" {...props}>
              {children}
            </ol>
          ),
          li: ({ children, ...props }) => (
            <li className="leading-snug" {...props}>
              {children}
            </li>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              className="my-1 pl-2 hairline-l text-fog-400 italic"
              {...props}
            >
              {children}
            </blockquote>
          ),
          a: ({ children, href, ...props }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-mint underline decoration-mint/40 underline-offset-2 hover:decoration-mint"
              {...props}
            >
              {children}
            </a>
          ),
          code: ({ inline, className: cls, children, ...props }: { inline?: boolean; className?: string; children?: React.ReactNode }) => {
            if (inline) {
              return (
                <code
                  className="font-mono text-[10.5px] px-1 py-0.5 rounded bg-ink-900/80 text-fog-100 hairline"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={clsx('font-mono', cls)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...props }) => (
            <pre
              className="my-1.5 p-2 rounded bg-ink-900/80 hairline overflow-x-auto code-scroll"
              {...props}
            >
              {children}
            </pre>
          ),
          hr: () => <hr className="my-2 hairline-b" />,
          table: ({ children, ...props }) => (
            <div className="my-1.5 overflow-x-auto code-scroll">
              <table className="font-mono text-[10.5px] tabular-nums" {...props}>
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th
              className="px-2 py-1 hairline-b font-mono text-[9.5px] uppercase tracking-widest2 text-fog-500 text-left"
              {...props}
            >
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="px-2 py-1 hairline-b text-fog-300" {...props}>
              {children}
            </td>
          ),
          strong: ({ children, ...props }) => (
            <strong className="text-fog-100 font-semibold" {...props}>
              {children}
            </strong>
          ),
          em: ({ children, ...props }) => (
            <em className="text-fog-200 italic" {...props}>
              {children}
            </em>
          ),
          del: ({ children, ...props }) => (
            <del className="text-fog-600 line-through" {...props}>
              {children}
            </del>
          ),
        }}
      >
        {/* Strip model-emitted tool-call protocol tokens (e.g.
            `<|tool_call_begin|>`) before rendering. Some local models
            leak these into their content stream rather than the
            tool-call channel. The sanitiser is conservative — only
            real protocol markers match. See lib/text-sanitize.ts. */}
        {stripProtocolTokens(text)}
      </ReactMarkdown>
    </div>
  );
}
