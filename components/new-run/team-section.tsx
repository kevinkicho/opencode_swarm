'use client';

// Step 04: team-picker section.
//
// Live opencode catalog (driven by /config/providers) shown as a row
// per model with +/− stepper. Includes the catalog-source badge
// (live / static), per-pattern recommended-max readout (#103), and the
// teamSizeWarning tooltip when totalAgents exceeds the empirical
// ceiling.
//
// 2026-04-28 — added a provider-tier filter chip strip above the
// model table. opencode exposes three pipelines:
//   - go      ← opencode-go/<model>:cloud — free daily quota; if
//                user has "extra usage" turned on at opencode.ai's
//                dashboard, auto-falls-through to zen billing on
//                quota hit. Recommended default.
//   - zen     ← opencode/<model>          — direct metered billing
//   - ollama  ← ollama/<model>:cloud      — $100/mo subscription cap
// (byok also exists but is rarely populated.) The model ID prefix
// determines the routing — picking a model from the `go` group
// implicitly routes through the Go pipeline. The filter chips just
// narrow which rows are visible; selection still happens per-row.

import clsx from 'clsx';
import { fmtZenPrice } from '@/lib/zen-catalog';
import { patternMeta, patternAccentText, teamSizeWarningMessage } from '@/lib/swarm-patterns';
import type { SwarmPattern } from '@/lib/swarm-types';
import type { ProviderModel } from '@/app/api/swarm/providers/route';
import {
  PROVIDER_META,
  PROVIDER_ORDER,
  useProviderFilter,
} from '@/lib/swarm-provider-tiers';
import { Tooltip } from '../ui/tooltip';
import {
  Section,
  CountStepper,
  HeaderCell,
  ModelNameCell,
  FamilyCell,
  PriceCell,
} from './sub-components';
import { OllamaHelpPopover } from './ollama-help-popover';

export function TeamSection({
  pattern,
  totalAgents,
  catalogSource,
  orderedModels,
  teamCounts,
  bumpCount,
  clearTeam,
}: {
  pattern: SwarmPattern;
  totalAgents: number;
  catalogSource: 'live' | 'fallback' | string;
  orderedModels: ProviderModel[];
  teamCounts: Record<string, number>;
  bumpCount: (id: string, delta: number) => void;
  clearTeam: () => void;
}) {
  const recommendedMax = patternMeta[pattern].recommendedMax;
  const teamSizeWarn = totalAgents > 0
    ? teamSizeWarningMessage(pattern, totalAgents)
    : undefined;

  const {
    providerFilter,
    providerCounts,
    filteredModels,
    toggleProvider,
  } = useProviderFilter(orderedModels);

  return (
    <Section
      step="04"
      label="team"
      optional
      hint="pick agents from the live opencode catalog (driven by /config/providers). stack multiples of the same model with the +/− stepper. leave empty and agents will spawn as work demands."
      trailing={
        <div className="flex items-center gap-2">
          {catalogSource === 'fallback' && (
            <Tooltip
              side="left"
              wide
              content={
                <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
                  opencode is unreachable — showing the bundled static catalog. once the
                  backend reconnects, the team picker repopulates from /config/providers.
                </div>
              }
            >
              <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-amber/70 cursor-help">
                static
              </span>
            </Tooltip>
          )}
          {catalogSource === 'live' && (
            <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-mint/70">
              live
            </span>
          )}
          <span className="font-mono text-[10.5px] text-fog-700 tabular-nums">
            {totalAgents} on deck
          </span>
        </div>
      }
    >
      <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
        {/* Provider-tier filter strip. The catalog already groups
            opencode-go vs opencode vs ollama via the model ID prefix
            (which determines billing routing); the chips below just
            narrow which rows are visible. Tooltip on each chip
            explains the routing semantics for that tier. */}
        <div className="px-3 h-7 hairline-b bg-ink-900/60 flex items-center gap-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 mr-1">
            provider
          </span>
          {PROVIDER_ORDER.filter((p) => providerCounts[p] > 0).map((p) => {
            const active = providerFilter.has(p);
            const meta = PROVIDER_META[p];
            return (
              <Tooltip
                key={p}
                side="top"
                wide
                content={
                  <div className="font-mono text-[10.5px] text-fog-400 leading-snug max-w-[320px]">
                    {meta.hint}
                  </div>
                }
              >
                <button
                  type="button"
                  onClick={() => toggleProvider(p)}
                  className={clsx(
                    'h-5 px-1.5 rounded font-mono text-[10px] uppercase tracking-widest2 transition cursor-pointer hairline flex items-center gap-1',
                    active
                      ? clsx('bg-ink-800', meta.accent)
                      : 'text-fog-700 hover:text-fog-400 opacity-60',
                  )}
                  aria-pressed={active}
                >
                  {meta.label}
                  <span className="font-mono text-[9px] tabular-nums opacity-70">
                    {providerCounts[p]}
                  </span>
                </button>
              </Tooltip>
            );
          })}
          {/* "?" help affordance — only mounted when there's at least
              one ollama model in scope, so non-ollama users don't see
              irrelevant chrome. The popover holds Layer 2 (checklist
              with click-to-copy) + Layer 3 (live diagnostic showing
              the gap between pulled-locally and declared-in-opencode). */}
          {providerCounts.ollama > 0 && (
            <OllamaHelpPopover
              ollamaModelsInCatalog={orderedModels.filter((m) => m.provider === 'ollama')}
            />
          )}
          <span className="ml-auto font-mono text-[9.5px] tabular-nums text-fog-700">
            {filteredModels.length}/{orderedModels.length} models
          </span>
        </div>
        <div className="px-3 h-6 hairline-b bg-ink-900/70 flex items-center gap-3">
          <HeaderCell cls="flex-1 min-w-0">model</HeaderCell>
          <HeaderCell cls="w-[82px]">family</HeaderCell>
          <HeaderCell cls="w-12 text-right">in $</HeaderCell>
          <HeaderCell cls="w-12 text-right">out $</HeaderCell>
          <HeaderCell cls="w-[74px] text-right">count</HeaderCell>
        </div>
        {filteredModels.length === 0 && (
          <div className="px-3 py-3 font-mono text-[10.5px] text-fog-600 leading-snug">
            no models — every provider tier is filtered out. click a provider chip above to bring its models back.
          </div>
        )}
        <ul className="max-h-[280px] overflow-y-auto">
          {filteredModels.map((m) => {
            const count = teamCounts[m.id] ?? 0;
            const active = count > 0;
            // Pricing may be missing when opencode reports a model we
            // have no override for and the upstream cost is undefined.
            // Render an em-dash so the column doesn't collapse.
            const inPrice = m.pricing ? fmtZenPrice(m.pricing.input) : '—';
            const outPrice = m.pricing ? fmtZenPrice(m.pricing.output) : '—';
            return (
              <li key={m.id}>
                <div
                  className={clsx(
                    'px-3 h-5 flex items-center gap-3 hairline-b last:border-b-0 transition',
                    active ? 'bg-ink-800' : 'hover:bg-ink-800/40'
                  )}
                >
                  <ModelNameCell label={m.label} active={active} />
                  <FamilyCell family={m.vendor} />
                  <PriceCell value={inPrice} cls="w-12 text-right" />
                  <PriceCell value={outPrice} cls="w-12 text-right" />
                  <CountStepper
                    count={count}
                    onMinus={() => bumpCount(m.id, -1)}
                    onPlus={() => bumpCount(m.id, +1)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
        <div className="hairline-t px-3 h-8 flex items-center gap-2 bg-ink-900/60">
          <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600">
            {totalAgents === 0 ? 'no agents selected' : `${totalAgents} selected`}
          </span>
          <button
            onClick={clearTeam}
            disabled={totalAgents === 0}
            className={clsx(
              'ml-auto h-6 px-2 rounded font-mono text-micro uppercase tracking-widest2 transition border',
              totalAgents === 0
                ? 'bg-ink-900 border-ink-700 text-fog-700 cursor-not-allowed'
                : 'bg-ink-900 border-ink-600 text-fog-400 hover:text-fog-100 hover:border-ink-500'
            )}
          >
            clear
          </button>
        </div>
      </div>
      <div className="mt-1 font-mono text-[10.5px] text-fog-700 leading-snug">
        agents self-select within the run's bounds. stacking N of the same model spawns N
        peer agents on that model.
      </div>
      {/* Layer 1 — always-visible ollama hint, only when ollama is
          among the active providers. Catches the structural case
          (opencode.json not updated and/or opencode not restarted)
          for first-time users without making them open the help
          popover. The "?" chip above carries Layers 2 + 3 for users
          who need more depth. */}
      {providerFilter.has('ollama') && providerCounts.ollama > 0 && (
        <div className="mt-1 font-mono text-[10.5px] text-fog-700 leading-snug">
          <span className="text-iris">ollama tip · </span>
          don't see a pulled model? declare it in your{' '}
          <code className="text-fog-500">opencode.json</code> ollama provider block, then
          restart opencode. <code className="text-fog-500">ollama pull</code> alone doesn't
          update opencode's catalog.
        </div>
      )}
      {/*
        recommended-max readout (#103). Empirical ceiling per pattern
        from the MAXTEAM-2026-04-26 stress test. Stays muted by default
        so it doesn't compete with the team picker; turns amber when
        totalAgents > recommendedMax to flag that the run is in
        degradation territory. Tooltip carries the full server-warn
        message so the user can read the exact failure-mode reference
        without leaving the modal.
      */}
      <div
        className={clsx(
          'mt-1 font-mono text-[10.5px] leading-snug flex items-center gap-2',
          teamSizeWarn ? 'text-amber/85' : 'text-fog-700',
        )}
      >
        <span>
          recommended max for{' '}
          <span className={patternAccentText[patternMeta[pattern].accent]}>
            {patternMeta[pattern].label}
          </span>
          : <span className="tabular-nums">{recommendedMax}</span>
          {totalAgents > 0 && (
            <>
              {' · current '}
              <span className="tabular-nums">{totalAgents}</span>
            </>
          )}
        </span>
        {teamSizeWarn && (
          <Tooltip content={teamSizeWarn}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              above ceiling — hover for failure modes
            </span>
          </Tooltip>
        )}
      </div>
    </Section>
  );
}
