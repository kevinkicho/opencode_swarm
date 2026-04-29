'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Modal } from './ui/modal';
import {
  fmtZenPrice as fmtPrice,
} from '@/lib/zen-catalog';
import {
  createSessionBrowser,
  postSessionMessageBrowser,
  useOpencodeProviders,
} from '@/lib/opencode/live';
import {
  PROVIDER_META,
  PROVIDER_ORDER,
  useProviderFilter,
} from '@/lib/swarm-provider-tiers';
import { Tooltip } from './ui/tooltip';
import {
  Section,
  HeaderCell,
  ModelNameCell,
  FamilyCell,
  PriceCell,
  SpawnModeToggle,
  SpawnButton,
  type SpawnState,
  type SpawnMode,
} from './spawn-agent/sub-components';
import { OllamaHelpPopover } from './new-run/ollama-help-popover';
import { PreviewPanel, type SpawnSkill } from './spawn-agent/preview-panel';

const skills: SpawnSkill[] = [
  { id: 'github',   name: 'github',   auth: 'pat classic' },
  { id: 'stripe',   name: 'stripe',   auth: 'secret key' },
  { id: 'slack',    name: 'slack',    auth: 'bot token' },
  { id: 'linear',   name: 'linear',   auth: 'api key' },
  { id: 'postgres', name: 'postgres', auth: 'conn string' },
  { id: 'sentry',   name: 'sentry',   auth: 'dsn + token' },
];

export function SpawnAgentModal({
  open,
  onClose,
  directory,
}: {
  open: boolean;
  onClose: () => void;
  directory: string | null;
}) {
  const router = useRouter();
  // Live provider/model catalog — replaces the static zenModels import.
  // Models are sorted by tier+label for stable picker order; first row
  // is the default selection until the user clicks one. Tier order
  // matches the new-run modal — go (free quota) before zen (metered)
  // before ollama (subscription) before byok.
  const { models: liveModels, source: catalogSource } = useOpencodeProviders();
  const orderedModels = useMemo(() => {
    const tierOrder = { go: 0, zen: 1, ollama: 2, byok: 3 } as const;
    return [...liveModels].sort((a, b) => {
      const t = tierOrder[a.provider] - tierOrder[b.provider];
      return t !== 0 ? t : a.label.localeCompare(b.label);
    });
  }, [liveModels]);
  const {
    providerFilter,
    providerCounts,
    filteredModels,
    toggleProvider,
  } = useProviderFilter(orderedModels);

 // Form state consolidated — useState-count reduction.
  // 7 useState pairs → 1 form object + 1 mode + 1 mutation (no useState).
  const [form, setForm] = useState<{
    modelId: string;
    selectedSkills: Set<string>;
    name: string;
    directive: string;
  }>({
    modelId: '',
    selectedSkills: new Set(),
    name: '',
    directive: '',
  });
  const { modelId, selectedSkills, name, directive } = form;
  const setModelId = (v: string) => setForm((p) => ({ ...p, modelId: v }));
  const setName = (v: string) => setForm((p) => ({ ...p, name: v }));
  const setDirective = (v: string) => setForm((p) => ({ ...p, directive: v }));
  const [spawnMode, setSpawnMode] = useState<SpawnMode>('idle');

  // Seed + re-seed the selected model. Two cases trigger:
  //  1. Catalog hydrates / fallback resolves — pick the first row.
  //  2. The active provider filter hides the currently-selected model
  //     (e.g. user picked an ollama model, then unticked the ollama
  //     chip) — slide selection to the first visible row so the
  //     preview panel never shows a model that's no longer in scope.
  useEffect(() => {
    const visibleHasCurrent = filteredModels.some((m) => m.id === modelId);
    if (!visibleHasCurrent && filteredModels[0]) {
      setForm((p) => ({ ...p, modelId: filteredModels[0].id }));
    }
  }, [filteredModels, modelId]);

  const autoId = 'agent-03';
  const trimmedName = name.trim();
  const trimmedDirective = directive.trim();
  const previewName = trimmedName || autoId;
  const currentModel =
    filteredModels.find((m) => m.id === modelId) ??
    orderedModels.find((m) => m.id === modelId) ??
    filteredModels[0] ??
    orderedModels[0];

  // Active mode needs a directive to actually activate on — otherwise it's
  // indistinguishable from idle. Idle is always valid: creates a parked session.
  const canSpawn =
    !!directory &&
    (spawnMode === 'idle' || trimmedDirective.length > 0);

  // (spawnState / spawnError + try/catch). TanStack manages pending +
  // success + error uniformly; the verified→navigate handoff stays as a
  // setTimeout so the verified UI render persists across the transition.
  const spawnMutation = useMutation({
    mutationFn: async (input: {
      title: string | undefined;
      activate: boolean;
    }): Promise<{ id: string }> => {
      if (!directory) throw new Error('no directory');
      const session = await createSessionBrowser(directory, input.title);
      if (input.activate && trimmedDirective) {
        await postSessionMessageBrowser(session.id, directory, trimmedDirective);
      }
      return session;
    },
    onSuccess: (session) => {
      // Short pause lets the verified state render before navigation so the
      // user sees the transition instead of a modal that just vanishes.
      setTimeout(() => {
        onClose();
        router.push(`/?session=${encodeURIComponent(session.id)}`);
      }, 350);
    },
  });
  const spawnState: SpawnState = spawnMutation.isPending
    ? 'verifying'
    : spawnMutation.isError
      ? 'failed'
      : spawnMutation.isSuccess
        ? 'verified'
        : 'idle';
  const spawnError = spawnMutation.error
    ? (spawnMutation.error as Error).message
    : null;

  useEffect(() => {
    if (open) spawnMutation.reset();
    // Effect intentionally re-runs only on `open` so a manual mutation
    // reset doesn't loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleSkill = useCallback((id: string) => {
    setForm((prev) => {
      const next = new Set(prev.selectedSkills);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, selectedSkills: next };
    });
  }, []);

  const handleSpawn = () => {
    if (spawnState === 'verifying' || !canSpawn || !directory) return;
    // Title priority: explicit name → first line of directive (capped) → let
    // opencode pick its default. Keeps the session picker readable.
    const firstLine = trimmedDirective.split(/\r?\n/)[0] ?? '';
    const derivedTitle =
      firstLine.length > 80 ? firstLine.slice(0, 77).trimEnd() + '…' : firstLine;
    const title = trimmedName || derivedTitle || undefined;
    spawnMutation.mutate({ title, activate: spawnMode === 'active' });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="spawn"
      title="new agent"
      width="max-w-[1440px]"
    >
      <div className="flex flex-col gap-3 min-h-0">
        <div
          className="grid gap-4 min-h-0"
          style={{ gridTemplateColumns: '1fr 320px 280px' }}
        >
          <div className="min-w-0 flex flex-col">
            <Section
              step="01"
              label="model"
              hint="live opencode catalog (driven by /config/providers). prices per 1M tokens click any row to pick"
              trailing={
                <div className="flex items-center gap-2">
                  {catalogSource === 'fallback' && (
                    <Tooltip
                      side="left"
                      wide
                      content={
                        <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
                          opencode is unreachable — showing the bundled static catalog. once the
                          backend reconnects, the picker repopulates from /config/providers.
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
                  <a
                    href="https://opencode.ai/docs/zen/"
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 hover:text-molten transition"
                  >
                    ref opencode.ai/docs/zen
                  </a>
                </div>
              }
            >
              <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
                {/* Provider-tier filter strip — same widget shape as
                    the new-run team picker. Click toggles narrow which
                    tiers are visible in the model list below; the model
                    IDs already encode tier via prefix, so this is purely
                    a presentation filter. */}
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
                  <HeaderCell cls="w-[92px]">family</HeaderCell>
                  <HeaderCell cls="w-14 text-right">in $</HeaderCell>
                  <HeaderCell cls="w-16 text-right">out $</HeaderCell>
                  <HeaderCell cls="w-14 text-right">cache r</HeaderCell>
                  <HeaderCell cls="w-14 text-right">cache w</HeaderCell>
                </div>
                {filteredModels.length === 0 && (
                  <div className="px-3 py-3 font-mono text-[10.5px] text-fog-600 leading-snug">
                    no models — every provider tier is filtered out. click a provider chip above to bring its models back.
                  </div>
                )}
                <ul>
                  {filteredModels.map((m) => {
                    const active = m.id === modelId;
                    const inPrice = m.pricing ? fmtPrice(m.pricing.input) : '—';
                    const outPrice = m.pricing ? fmtPrice(m.pricing.output) : '—';
                    const cacheReadPrice = m.cacheRead != null ? fmtPrice(m.cacheRead) : '—';
                    const cacheWritePrice = m.cacheWrite != null ? fmtPrice(m.cacheWrite, true) : '—';
                    return (
                      <li key={m.id}>
                        <button
                          onClick={() => setModelId(m.id)}
                          className={clsx(
                            'w-full px-3 h-5 flex items-center gap-3 hairline-b last:border-b-0 transition text-left',
                            active ? 'bg-ink-800' : 'hover:bg-ink-800/60'
                          )}
                        >
                          <ModelNameCell label={m.label} active={active} />
                          <FamilyCell family={m.vendor} />
                          <PriceCell value={inPrice} cls="w-14 text-right" />
                          <PriceCell value={outPrice} cls="w-16 text-right" />
                          <PriceCell value={cacheReadPrice} cls="w-14 text-right" muted />
                          <PriceCell value={cacheWritePrice} cls="w-14 text-right" muted />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="mt-1.5 font-mono text-[10.5px] text-fog-700 leading-snug">
                pricing and catalog pulled from{' '}
                <a
                  href="https://opencode.ai/docs/zen/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-fog-500 hover:text-molten transition"
                >
                  opencode.ai/docs/zen
                </a>
                . model selection is cosmetic today — the session runs with whatever opencode picks per prompt.
              </div>
              {/* Layer 1 ollama hint — same logic as the new-run team
                  picker. Catches the structural case (config not
                  updated and/or opencode not restarted) without
                  forcing the user to open the help popover. */}
              {providerFilter.has('ollama') && providerCounts.ollama > 0 && (
                <div className="mt-1 font-mono text-[10.5px] text-fog-700 leading-snug">
                  <span className="text-iris">ollama tip · </span>
                  don't see a pulled model? declare it in your{' '}
                  <code className="text-fog-500">opencode.json</code> ollama provider block, then
                  restart opencode. <code className="text-fog-500">ollama pull</code> alone doesn't
                  update opencode's catalog.
                </div>
              )}
            </Section>
          </div>

          <div className="min-w-0 flex flex-col gap-3">
            <Section
              step="02"
              label="name"
              optional
              hint="shown in roster + timeline leave blank for an auto id like agent-03"
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ember, atlas, forge, keel ..."
                className="w-full h-9 px-3 rounded bg-ink-900/40 border border-dashed border-ink-600/60 text-[13px] text-fog-300 placeholder:text-fog-700 focus:outline-none focus:bg-ink-900 focus:border-solid focus:border-molten/40 focus:text-fog-100 transition"
              />
            </Section>

            <Section
              step="03"
              label="directive"
              optional
              hint="scope brief useful at 5+ agents to stop collisions leave blank to let the agent roam and self-negotiate scope on spawn"
            >
              <textarea
                value={directive}
                onChange={(e) => setDirective(e.target.value)}
                placeholder="You are a ___ agent. Your job is to ___. Constraints: ___"
                rows={4}
                className="w-full px-3 py-2 rounded bg-ink-900/40 border border-dashed border-ink-600/60 text-[12.5px] text-fog-400 placeholder:text-fog-700 focus:outline-none focus:bg-ink-900 focus:border-solid focus:border-molten/40 focus:text-fog-200 transition resize-none leading-relaxed font-mono"
              />
            </Section>

            <Section
              step="04"
              label="skills"
              hint="credentialed integrations the agent opts into built-in tools come free"
            >
              <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
                <ul>
                  {skills.map((s) => {
                    const active = selectedSkills.has(s.id);
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => toggleSkill(s.id)}
                          className={clsx(
                            'w-full text-left px-3 h-6 hairline-b last:border-b-0 transition flex items-center gap-2.5',
                            active ? 'bg-ink-800' : 'hover:bg-ink-800/60'
                          )}
                        >
                          <span
                            className={clsx(
                              'w-3 h-3 rounded-sm border shrink-0 flex items-center justify-center transition',
                              active ? 'bg-molten/80 border-molten' : 'border-fog-600 bg-ink-900'
                            )}
                          >
                            {active && <span className="w-1 h-1 bg-ink-900 rounded-[1px]" />}
                          </span>
                          <span className="font-mono text-[11.5px] text-fog-200 flex-1 min-w-0 truncate">
                            {s.name}
                          </span>
                          <span className="inline-flex items-center h-4 px-1.5 text-[9px] border rounded-[3px] font-mono tracking-wider uppercase border-ink-500 bg-ink-800 text-fog-400 shrink-0">
                            {s.auth}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Section>
          </div>

          <PreviewPanel
            previewName={previewName}
            trimmedName={trimmedName}
            spawnMode={spawnMode}
            currentModel={currentModel}
            selectedSkills={selectedSkills}
            skills={skills}
            directive={directive}
          />
        </div>
      </div>

      <div className="mt-4 pt-3 hairline-t flex items-center gap-2">
        <button
          onClick={onClose}
          className="h-8 px-3 rounded font-mono text-micro uppercase tracking-wider bg-ink-900 hairline text-fog-400 hover:border-ink-500 transition"
        >
          cancel
        </button>
        {spawnError ? (
          <div className="ml-2 font-mono text-[10.5px] text-rust truncate min-w-0 max-w-[420px]">
            {spawnError}
          </div>
        ) : !directory ? (
          <div className="ml-2 font-mono text-[10.5px] text-fog-600 truncate min-w-0">
            open a live session to spawn into its workspace
          </div>
        ) : spawnMode === 'active' && !trimmedDirective ? (
          <div className="ml-2 font-mono text-[10.5px] text-fog-600 truncate min-w-0">
            active mode needs a directive — add one or switch to idle
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <SpawnModeToggle mode={spawnMode} onChange={setSpawnMode} />
          <SpawnButton
            state={spawnState}
            mode={spawnMode}
            onClick={handleSpawn}
            disabled={!canSpawn}
          />
        </div>
      </div>
    </Modal>
  );
}
