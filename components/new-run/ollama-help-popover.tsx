'use client';

// "Don't see your ollama model?" help popover — Layer 2 (checklist
// with click-to-copy commands) + Layer 3 (live diagnostic showing
// the gap between pulled-locally and declared-in-opencode).
//
// The companion to the always-visible footer hint (Layer 1) inside
// TeamSection. Triggered by a `?` chip in the provider strip when
// the ollama tier is in scope.

import { useMemo, useState } from 'react'; // useState used by CopyChip
import clsx from 'clsx';
import { Popover } from '../ui/popover';
import { useOllamaTags } from '@/lib/opencode/live/use-ollama-tags';
import type { ProviderModel } from '@/app/api/swarm/providers/route';

// The popover's parent (TeamSection) only mounts this component when
// the ollama tier has at least one model in the catalog. The fetch
// kicks off on first mount with a 30s staleTime so subsequent
// modal-opens reuse the snapshot.

function CopyChip({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard blocked (e.g. non-secure context) — silent no-op;
      // the text is selectable so the user can still drag-copy.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-widest2 border transition shrink-0 cursor-pointer',
        copied
          ? 'bg-mint/15 text-mint border-mint/30'
          : 'bg-ink-900 text-fog-500 border-ink-700 hover:text-fog-200 hover:border-ink-500',
      )}
      aria-label={`copy ${label ?? text}`}
    >
      {copied ? 'copied ✓' : 'copy'}
    </button>
  );
}

export function OllamaHelpPopover({
  ollamaModelsInCatalog,
}: {
  // The ollama-tier rows from /api/swarm/providers — used to compute
  // the "in catalog vs pulled" diff. Pass them in from TeamSection
  // so we don't refetch in the popover.
  ollamaModelsInCatalog: ProviderModel[];
}) {
  const tags = useOllamaTags();

  const catalogIds = useMemo(
    () => new Set(ollamaModelsInCatalog.map((m) => m.id.replace(/^ollama\//, ''))),
    [ollamaModelsInCatalog],
  );
  const pulled = tags.pulled ?? [];
  const pulledSet = useMemo(() => new Set(pulled), [pulled]);
  const pulledNotInCatalog = useMemo(
    () => pulled.filter((p) => !catalogIds.has(p)),
    [pulled, catalogIds],
  );
  const inCatalogNotPulled = useMemo(
    () => Array.from(catalogIds).filter((id) => !pulledSet.has(id)),
    [catalogIds, pulledSet],
  );

  return (
    <Popover
      side="bottom"
      align="start"
      width={460}
      content={() => (
        <div className="px-3 py-3 space-y-3">
          {/* Title + intent */}
          <div>
            <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              missing an ollama model?
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-fog-600 leading-snug">
              the picker shows what opencode declares — that's a different
              source than what ollama has pulled locally. four common gaps:
            </div>
          </div>

          {/* Layer 2 — checklist */}
          <ol className="space-y-2 list-none pl-0">
            <li className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200">
                <span className="text-fog-600 mr-1">1.</span> is it pulled?
              </div>
              <div className="flex items-center gap-2">
                <code className="font-mono text-[10.5px] text-fog-400 bg-ink-900/60 hairline rounded px-1.5 py-0.5 flex-1 truncate">
                  ollama list
                </code>
                <CopyChip text="ollama list" label="ollama list command" />
              </div>
              <div className="font-mono text-[10px] text-fog-600 leading-snug">
                look for the exact model id (incl. <code className="text-fog-400">:cloud</code> /{' '}
                <code className="text-fog-400">:7b</code> etc. tag suffix).
              </div>
            </li>

            <li className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200">
                <span className="text-fog-600 mr-1">2.</span> is it declared in opencode.json?
              </div>
              <div className="flex items-center gap-2">
                <code className="font-mono text-[10.5px] text-fog-400 bg-ink-900/60 hairline rounded px-1.5 py-0.5 flex-1 truncate">
                  cat ~/.config/opencode/opencode.json
                </code>
                <CopyChip text="cat ~/.config/opencode/opencode.json" label="cat opencode.json" />
              </div>
              <div className="font-mono text-[10px] text-fog-600 leading-snug">
                the ollama provider block must list it under <code className="text-fog-400">models</code>.
              </div>
            </li>

            <li className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200">
                <span className="text-fog-600 mr-1">3.</span> did you restart opencode after editing config?
              </div>
              <div className="font-mono text-[10px] text-fog-600 leading-snug">
                opencode loads provider blocks at startup. <code className="text-fog-400">ollama pull</code> alone
                doesn't notify it; the catalog is frozen until the daemon restarts.
              </div>
            </li>

            <li className="space-y-1">
              <div className="font-mono text-[11px] text-fog-200">
                <span className="text-fog-600 mr-1">4.</span> tag mismatch?
              </div>
              <div className="font-mono text-[10px] text-fog-600 leading-snug">
                the model id in opencode.json must exactly match what{' '}
                <code className="text-fog-400">ollama list</code> shows.{' '}
                <code className="text-fog-400">glm-5.1</code> ≠{' '}
                <code className="text-fog-400">glm-5.1:cloud</code> ≠{' '}
                <code className="text-fog-400">glm-5.1:7b</code>.
              </div>
            </li>
          </ol>

          {/* Layer 3 — live diagnostic */}
          <div className="hairline-t pt-2 space-y-1.5">
            <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
              live diagnostic
            </div>
            {tags.isLoading && (
              <div className="font-mono text-[10.5px] text-fog-600 animate-pulse">
                probing ollama at <code className="text-fog-500">{tags.snapshot?.ollamaUrl ?? 'OLLAMA_URL'}</code> …
              </div>
            )}
            {!tags.isLoading && (
              <div className="font-mono text-[10.5px] tabular-nums space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-fog-600 w-32">ollama reachable</span>
                  <span className={clsx(tags.reachable ? 'text-mint' : 'text-rust')}>
                    {tags.reachable ? '✓' : '✗ unreachable'}
                  </span>
                  {tags.snapshot?.ollamaUrl && (
                    <span className="text-fog-700 ml-auto truncate">
                      {tags.snapshot.ollamaUrl}
                    </span>
                  )}
                </div>
                {tags.reachable && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-fog-600 w-32">models pulled</span>
                      <span className="text-fog-200">{pulled.length}</span>
                      {pulled.length > 0 && (
                        <span className="text-fog-600 truncate">
                          ({pulled.slice(0, 3).join(' · ')}
                          {pulled.length > 3 ? ` · +${pulled.length - 3}` : ''})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-fog-600 w-32">models in catalog</span>
                      <span className="text-fog-200">{ollamaModelsInCatalog.length}</span>
                      <span className="text-fog-600">(per opencode's /config/providers)</span>
                    </div>
                    {pulledNotInCatalog.length > 0 && (
                      <div className="flex items-baseline gap-2 pt-0.5">
                        <span className="text-amber w-32 shrink-0">pulled but invisible</span>
                        <span className="text-fog-300 break-all">
                          {pulledNotInCatalog.join(' · ')}
                        </span>
                      </div>
                    )}
                    {pulledNotInCatalog.length > 0 && (
                      <div className="font-mono text-[10px] text-fog-600 leading-snug pl-2">
                        ↑ opencode doesn't know about these. add them to{' '}
                        <code className="text-fog-400">opencode.json</code> ollama
                        provider block + restart.
                      </div>
                    )}
                    {inCatalogNotPulled.length > 0 && (
                      <div className="flex items-baseline gap-2 pt-0.5">
                        <span className="text-amber w-32 shrink-0">in catalog, not pulled</span>
                        <span className="text-fog-300 break-all">
                          {inCatalogNotPulled.join(' · ')}
                        </span>
                      </div>
                    )}
                    {inCatalogNotPulled.length > 0 && (
                      <div className="font-mono text-[10px] text-fog-600 leading-snug pl-2">
                        ↑ opencode lists these but you haven't pulled. run{' '}
                        <code className="text-fog-400">ollama pull &lt;name&gt;</code>{' '}
                        for the one you want.
                      </div>
                    )}
                    {pulledNotInCatalog.length === 0 && inCatalogNotPulled.length === 0 && (
                      <div className="text-mint">✓ pulled list matches opencode catalog</div>
                    )}
                  </>
                )}
                {!tags.reachable && tags.error && (
                  <div className="text-fog-600 leading-snug">
                    {tags.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    >
      <button
        type="button"
        className="h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-widest2 cursor-pointer hairline bg-ink-900 text-fog-500 hover:text-fog-200 hover:border-ink-500 transition"
        title="diagnose missing ollama model"
        aria-label="ollama help"
      >
        ?
      </button>
    </Popover>
  );
}
