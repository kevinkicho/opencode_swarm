'use client';

import clsx from 'clsx';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Modal } from './ui/modal';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';
import {
  zenModels,
  familyMeta,
  fmtZenPrice as fmtPrice,
  type ZenFamily as Family,
} from '@/lib/zen-catalog';
import {
  createSessionBrowser,
  postSessionMessageBrowser,
} from '@/lib/opencode/live';

interface Skill {
  id: string;
  name: string;
  auth: string;
}

const skills: Skill[] = [
  { id: 'github',   name: 'github',   auth: 'pat classic' },
  { id: 'stripe',   name: 'stripe',   auth: 'secret key' },
  { id: 'slack',    name: 'slack',    auth: 'bot token' },
  { id: 'linear',   name: 'linear',   auth: 'api key' },
  { id: 'postgres', name: 'postgres', auth: 'conn string' },
  { id: 'sentry',   name: 'sentry',   auth: 'dsn + token' },
];

type SpawnState = 'idle' | 'verifying' | 'failed' | 'verified';
type SpawnMode = 'idle' | 'active';

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
  // Form state consolidated — HARDENING_PLAN.md#C8 useState-count reduction.
  // 7 useState pairs → 1 form object + 1 mode + 1 mutation (no useState).
  const [form, setForm] = useState<{
    modelId: string;
    selectedSkills: Set<string>;
    name: string;
    directive: string;
  }>({
    modelId: zenModels[0].id,
    selectedSkills: new Set(),
    name: '',
    directive: '',
  });
  const { modelId, selectedSkills, name, directive } = form;
  const setModelId = (v: string) => setForm((p) => ({ ...p, modelId: v }));
  const setName = (v: string) => setForm((p) => ({ ...p, name: v }));
  const setDirective = (v: string) => setForm((p) => ({ ...p, directive: v }));
  const [spawnMode, setSpawnMode] = useState<SpawnMode>('idle');

  const autoId = 'agent-03';
  const trimmedName = name.trim();
  const trimmedDirective = directive.trim();
  const previewName = trimmedName || autoId;
  const currentModel = zenModels.find((m) => m.id === modelId) ?? zenModels[0];

  // Active mode needs a directive to actually activate on — otherwise it's
  // indistinguishable from idle. Idle is always valid: creates a parked session.
  const canSpawn =
    !!directory &&
    (spawnMode === 'idle' || trimmedDirective.length > 0);

  // HARDENING_PLAN.md#E9 — useMutation replaces the prior 3-state flow
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
              hint="opencode zen catalog prices per 1M tokens click any row to pick"
              trailing={
                <a
                  href="https://opencode.ai/docs/zen/"
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600 hover:text-molten transition"
                >
                  ref opencode.ai/docs/zen
                </a>
              }
            >
              <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
                <div className="px-3 h-6 hairline-b bg-ink-900/70 flex items-center gap-3">
                  <HeaderCell cls="flex-1 min-w-0">model</HeaderCell>
                  <HeaderCell cls="w-[92px]">family</HeaderCell>
                  <HeaderCell cls="w-14 text-right">in $</HeaderCell>
                  <HeaderCell cls="w-16 text-right">out $</HeaderCell>
                  <HeaderCell cls="w-14 text-right">cache r</HeaderCell>
                  <HeaderCell cls="w-14 text-right">cache w</HeaderCell>
                </div>
                <ul>
                  {zenModels.map((m) => {
                    const active = m.id === modelId;
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
                          <FamilyCell family={m.family} />
                          <PriceCell value={fmtPrice(m.in)} cls="w-14 text-right" />
                          <PriceCell value={fmtPrice(m.out)} cls="w-16 text-right" />
                          <PriceCell value={fmtPrice(m.cacheRead)} cls="w-14 text-right" muted />
                          <PriceCell value={fmtPrice(m.cacheWrite, true)} cls="w-14 text-right" muted />
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

          <aside className="min-w-0 flex flex-col gap-3">
            <div>
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-2">
                preview
              </div>
              <div className="relative rounded-md hairline bg-ink-900/60 overflow-hidden border border-molten/40">
                <div className="h-[3px] w-full bg-molten" />
                <div className="p-3 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'w-1.5 h-1.5 rounded-full',
                        spawnMode === 'active' ? 'bg-mint animate-pulse' : 'bg-molten'
                      )}
                    />
                    <span
                      className={clsx(
                        'text-[13px] truncate flex-1 min-w-0',
                        trimmedName ? 'text-fog-100' : 'text-fog-500 italic'
                      )}
                    >
                      {previewName}
                    </span>
                    <span
                      className={clsx(
                        'font-mono text-micro uppercase tracking-widest2',
                        spawnMode === 'active' ? 'text-mint' : 'text-fog-700'
                      )}
                    >
                      {spawnMode}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <ProviderBadge provider="zen" label={currentModel.label} size="sm" />
                  </div>

                  <div className="pt-1 hairline-t">
                    <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-1.5 mt-1.5">
                      skills
                    </div>
                    {selectedSkills.size === 0 ? (
                      <div className="text-[11.5px] text-fog-700 italic font-mono">
                        none built-ins only
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {skills
                          .filter((s) => selectedSkills.has(s.id))
                          .map((s) => (
                            <span
                              key={s.id}
                              className="inline-flex items-center h-4 px-1.5 text-[9px] border rounded-[3px] font-mono tracking-wider uppercase border-ink-500 bg-ink-800 text-fog-300"
                            >
                              {s.name}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-1 hairline-t">
                    <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-1.5 mt-1.5">
                      directive
                    </div>
                    <div className="text-[11.5px] text-fog-500 leading-relaxed font-mono">
                      {directive.trim() ? (
                        <>
                          {directive.slice(0, 160)}
                          {directive.length > 160 ? '...' : ''}
                        </>
                      ) : (
                        <span className="text-fog-700 italic">
                          no brief agent will roam and self-negotiate scope
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-md hairline bg-ink-900/40 p-3 space-y-1.5">
              <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                next step
              </div>
              <div className="text-[11px] text-fog-400 leading-snug">
                Agent enters the roster in {spawnMode} mode. Every model inherits
                opencode's built-in tools (read, edit, bash, grep, task ...) for
                free. Skills add credentialed integrations on top.
              </div>
            </div>
          </aside>
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

function Section({
  step,
  label,
  hint,
  optional,
  trailing,
  children,
}: {
  step: string;
  label: string;
  hint?: string;
  optional?: boolean;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const labelEl = (
    <span
      className={clsx(
        'font-mono text-micro uppercase tracking-widest2 text-fog-300 transition',
        hint &&
          'cursor-help border-b border-dotted border-fog-700 hover:text-fog-100 hover:border-fog-500'
      )}
    >
      {label}
    </span>
  );
  return (
    <section>
      <header className="flex items-center gap-2 mb-2">
        <span className="font-mono text-micro text-fog-700 tabular-nums">{step}</span>
        {hint ? (
          <Tooltip side="top" align="start" wide content={hint}>
            {labelEl}
          </Tooltip>
        ) : (
          labelEl
        )}
        {optional && (
          <span className="font-mono text-[9px] uppercase tracking-widest2 text-fog-700 border border-ink-600 rounded-[3px] px-1 h-3.5 inline-flex items-center">
            optional
          </span>
        )}
        {trailing && <span className="ml-auto">{trailing}</span>}
      </header>
      {children}
    </section>
  );
}

function HeaderCell({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        'font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 truncate',
        cls
      )}
    >
      {children}
    </span>
  );
}

function ModelNameCell({ label, active }: { label: string; active: boolean }) {
  return (
    <span className="flex-1 min-w-0 flex items-center">
      <span
        className={clsx(
          'font-mono text-[11.5px] truncate',
          active ? 'text-fog-100' : 'text-fog-300'
        )}
      >
        {label}
      </span>
    </span>
  );
}

function FamilyCell({ family }: { family: Family }) {
  const meta = familyMeta[family];
  return (
    <span
      className={clsx(
        'font-mono text-[10px] uppercase tracking-wider w-[92px] truncate',
        meta.color
      )}
    >
      {meta.label}
    </span>
  );
}

function PriceCell({
  value,
  cls,
  muted,
}: {
  value: string;
  cls: string;
  muted?: boolean;
}) {
  return (
    <span
      className={clsx(
        'font-mono text-[11px] tabular-nums truncate',
        cls,
        muted ? 'text-fog-500' : 'text-fog-200'
      )}
    >
      {value}
    </span>
  );
}

function SpawnModeToggle({
  mode,
  onChange,
}: {
  mode: SpawnMode;
  onChange: (m: SpawnMode) => void;
}) {
  return (
    <Tooltip
      side="top"
      align="end"
      wide
      content={
        <div className="space-y-1">
          <div className="font-mono text-[11px] text-fog-200">spawn mode</div>
          <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
            <span className="text-fog-200">idle</span> sits in the roster until
            another agent dispatches it via the task tool good for on-demand peers.
          </div>
          <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
            <span className="text-mint">active</span> boots warm and immediately
            advertises availability good for long-running watchers and monitors.
          </div>
        </div>
      }
    >
      <span className="inline-flex items-center h-8 hairline rounded p-0.5 bg-ink-900 cursor-help">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChange('idle');
          }}
          className={clsx(
            'h-7 px-2.5 rounded font-mono text-micro uppercase tracking-wider transition',
            mode === 'idle'
              ? 'bg-ink-800 text-fog-200 hairline'
              : 'text-fog-600 hover:text-fog-300'
          )}
        >
          idle
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onChange('active');
          }}
          className={clsx(
            'h-7 px-2.5 rounded font-mono text-micro uppercase tracking-wider transition',
            mode === 'active'
              ? 'bg-ink-800 text-mint hairline'
              : 'text-fog-600 hover:text-fog-300'
          )}
        >
          active
        </button>
      </span>
    </Tooltip>
  );
}

function SpawnButton({
  state,
  mode,
  onClick,
  disabled,
}: {
  state: SpawnState;
  mode: SpawnMode;
  onClick: () => void;
  disabled?: boolean;
}) {
  if (state === 'verifying') {
    return (
      <button
        disabled
        className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-amber/10 text-amber border border-amber/30 transition flex items-center gap-2 cursor-wait"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
        spawning…
      </button>
    );
  }
  if (state === 'verified') {
    return (
      <button
        disabled
        className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-mint/10 text-mint border border-mint/30 transition flex items-center gap-2"
      >
        spawned {mode}
      </button>
    );
  }
  if (state === 'failed') {
    return (
      <button
        onClick={onClick}
        disabled={disabled}
        className={clsx(
          'h-8 px-4 rounded font-mono text-micro uppercase tracking-wider transition flex items-center gap-2',
          disabled
            ? 'bg-ink-800 text-fog-600 border border-ink-700 cursor-not-allowed'
            : 'bg-rust/15 hover:bg-rust/25 text-rust border border-rust/30'
        )}
      >
        retry spawn
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'h-8 px-4 rounded font-mono text-micro uppercase tracking-wider transition',
        disabled
          ? 'bg-ink-800 text-fog-600 border border-ink-700 cursor-not-allowed'
          : 'bg-molten/15 hover:bg-molten/25 text-molten border border-molten/30'
      )}
    >
      spawn {mode === 'active' ? 'active' : 'agent'}
    </button>
  );
}
