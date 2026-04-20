'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Modal } from './ui/modal';
import { ProviderBadge } from './provider-badge';
import { Tooltip } from './ui/tooltip';

type Family =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'alibaba'
  | 'moonshot'
  | 'zhipu'
  | 'minimax'
  | 'nvidia'
  | 'stealth';
type Tier = 'premium' | 'standard' | 'budget' | 'coding' | 'free' | 'fast';

interface ZenModel {
  id: string;
  label: string;
  family: Family;
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  tier: Tier;
}

// Pricing pulled from https://opencode.ai/docs/zen/ - per 1M tokens.
// cacheWrite is anthropic-only; left at 0 (renders as em-dash) for the rest.
const zenModels: ZenModel[] = [
  { id: 'claude-opus-4.7',   label: 'claude opus 4.7',   family: 'anthropic', in: 5.0,  out: 25.0,  cacheRead: 0.5,   cacheWrite: 6.25, tier: 'premium' },
  { id: 'claude-opus-4.6',   label: 'claude opus 4.6',   family: 'anthropic', in: 5.0,  out: 25.0,  cacheRead: 0.5,   cacheWrite: 6.25, tier: 'premium' },
  { id: 'claude-opus-4.5',   label: 'claude opus 4.5',   family: 'anthropic', in: 5.0,  out: 25.0,  cacheRead: 0.5,   cacheWrite: 6.25, tier: 'premium' },
  { id: 'claude-sonnet-4.6', label: 'claude sonnet 4.6', family: 'anthropic', in: 3.0,  out: 15.0,  cacheRead: 0.3,   cacheWrite: 3.75, tier: 'standard' },
  { id: 'claude-haiku-4.5',  label: 'claude haiku 4.5',  family: 'anthropic', in: 1.0,  out: 5.0,   cacheRead: 0.1,   cacheWrite: 1.25, tier: 'budget' },
  { id: 'gpt-5.4-pro',       label: 'gpt 5.4 pro',       family: 'openai',    in: 30.0, out: 180.0, cacheRead: 30.0,  cacheWrite: 0,    tier: 'premium' },
  { id: 'gpt-5.4',           label: 'gpt 5.4',           family: 'openai',    in: 2.5,  out: 15.0,  cacheRead: 0.25,  cacheWrite: 0,    tier: 'standard' },
  { id: 'gpt-5.4-mini',      label: 'gpt 5.4 mini',      family: 'openai',    in: 0.75, out: 4.5,   cacheRead: 0.075, cacheWrite: 0,    tier: 'budget' },
  { id: 'gpt-5.4-nano',      label: 'gpt 5.4 nano',      family: 'openai',    in: 0.2,  out: 1.25,  cacheRead: 0.02,  cacheWrite: 0,    tier: 'budget' },
  { id: 'gpt-5.3-codex',     label: 'gpt 5.3 codex',     family: 'openai',    in: 1.75, out: 14.0,  cacheRead: 0.175, cacheWrite: 0,    tier: 'coding' },
  { id: 'gpt-5.2-codex',     label: 'gpt 5.2 codex',     family: 'openai',    in: 1.75, out: 14.0,  cacheRead: 0.175, cacheWrite: 0,    tier: 'coding' },
  { id: 'gpt-5-codex',       label: 'gpt 5 codex',       family: 'openai',    in: 1.07, out: 8.5,   cacheRead: 0.107, cacheWrite: 0,    tier: 'standard' },
  { id: 'gpt-5-nano-free',   label: 'gpt 5 nano',        family: 'openai',    in: 0,    out: 0,     cacheRead: 0,     cacheWrite: 0,    tier: 'free' },
  { id: 'gemini-3.1-pro',    label: 'gemini 3.1 pro',    family: 'google',    in: 4.0,  out: 18.0,  cacheRead: 0.4,   cacheWrite: 0,    tier: 'premium' },
  { id: 'gemini-3-flash',    label: 'gemini 3 flash',    family: 'google',    in: 0.5,  out: 3.0,   cacheRead: 0.05,  cacheWrite: 0,    tier: 'fast' },
  { id: 'qwen-3.6-plus',     label: 'qwen 3.6 plus',     family: 'alibaba',   in: 0.5,  out: 3.0,   cacheRead: 0.05,  cacheWrite: 0,    tier: 'standard' },
  { id: 'qwen-3.5-plus',     label: 'qwen 3.5 plus',     family: 'alibaba',   in: 0.2,  out: 1.2,   cacheRead: 0.02,  cacheWrite: 0,    tier: 'budget' },
  { id: 'kimi-k2.5',         label: 'kimi k2.5',         family: 'moonshot',  in: 0.6,  out: 3.0,   cacheRead: 0.1,   cacheWrite: 0,    tier: 'standard' },
  { id: 'glm-5.1',           label: 'glm 5.1',           family: 'zhipu',     in: 1.4,  out: 4.4,   cacheRead: 0.26,  cacheWrite: 0,    tier: 'premium' },
  { id: 'glm-5',             label: 'glm 5',             family: 'zhipu',     in: 1.0,  out: 3.2,   cacheRead: 0.2,   cacheWrite: 0,    tier: 'standard' },
  { id: 'minimax-m2.5',      label: 'minimax m2.5',      family: 'minimax',   in: 0.3,  out: 1.2,   cacheRead: 0.06,  cacheWrite: 0,    tier: 'budget' },
];

const tierMeta: Record<Tier, { label: string; cls: string }> = {
  premium:  { label: 'prem', cls: 'text-molten border-molten/30 bg-molten/10' },
  standard: { label: 'std',  cls: 'text-fog-300 border-ink-500 bg-ink-800' },
  budget:   { label: 'budg', cls: 'text-mint border-mint/25 bg-mint/5' },
  coding:   { label: 'code', cls: 'text-iris border-iris/30 bg-iris/10' },
  free:     { label: 'free', cls: 'text-amber border-amber/30 bg-amber/10' },
  fast:     { label: 'fast', cls: 'text-mint border-mint/30 bg-mint/10' },
};

const familyMeta: Record<Family, { label: string; color: string }> = {
  anthropic: { label: 'anthropic', color: 'text-amber' },
  openai:    { label: 'openai',    color: 'text-mint' },
  google:    { label: 'google',    color: 'text-iris' },
  alibaba:   { label: 'alibaba',   color: 'text-fog-300' },
  moonshot:  { label: 'moonshot',  color: 'text-fog-400' },
  zhipu:     { label: 'zhipu',     color: 'text-fog-300' },
  minimax:   { label: 'minimax',   color: 'text-fog-400' },
  nvidia:    { label: 'nvidia',    color: 'text-fog-300' },
  stealth:   { label: 'stealth',   color: 'text-fog-500' },
};

const fmtPrice = (n: number, isCacheWrite = false): string => {
  if (n === 0) return isCacheWrite ? '\u2014' : '0';
  if (n < 0.1) return n.toFixed(3);
  return n.toFixed(2);
};

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

export function SpawnAgentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [modelId, setModelId] = useState<string>(zenModels[0].id);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [directive, setDirective] = useState('');
  const [spawnState, setSpawnState] = useState<SpawnState>('idle');
  const [spawnMode, setSpawnMode] = useState<SpawnMode>('idle');

  const autoId = 'agent-03';
  const trimmedName = name.trim();
  const previewName = trimmedName || autoId;
  const currentModel = zenModels.find((m) => m.id === modelId) ?? zenModels[0];

  useEffect(() => {
    if (open) setSpawnState('idle');
  }, [open]);

  const toggleSkill = (id: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSpawn = () => {
    if (spawnState === 'verifying') return;
    setSpawnState('verifying');
    setTimeout(() => {
      setSpawnState('verified');
      setTimeout(onClose, 350);
    }, 700);
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
                  ref opencode.ai/docs/zen ↗
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
                  <HeaderCell cls="w-12">tier</HeaderCell>
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
                          <TierCell tier={m.tier} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="mt-1.5 font-mono text-[10.5px] text-fog-700 leading-snug">
                spawn does a soft opencode-account check before the agent boots.
                pricing and catalog pulled from{' '}
                <a
                  href="https://opencode.ai/docs/zen/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-fog-500 hover:text-molten transition"
                >
                  opencode.ai/docs/zen
                </a>
                .
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
                placeholder="coder alpha, scout, reviewer ..."
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
        <div className="ml-auto flex items-center gap-2">
          <SpawnModeToggle mode={spawnMode} onChange={setSpawnMode} />
          <SpawnButton state={spawnState} mode={spawnMode} onClick={handleSpawn} />
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
    <span className="flex-1 min-w-0 flex items-center gap-2">
      <span
        className={clsx(
          'w-1 h-1 rounded-full shrink-0 transition',
          active ? 'bg-molten' : 'bg-fog-700'
        )}
      />
      <span className="font-mono text-[11.5px] text-fog-200 truncate">{label}</span>
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

function TierCell({ tier }: { tier: Tier }) {
  const meta = tierMeta[tier];
  return (
    <span className="w-12 flex">
      <span
        className={clsx(
          'inline-flex items-center h-4 px-1 text-[9px] border rounded-[3px] font-mono tracking-wider uppercase',
          meta.cls
        )}
      >
        {meta.label}
      </span>
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
            <span className="text-fog-200">idle</span> sits in the roster until the
            orchestrator dispatches it via the task tool good for on-demand peers.
          </div>
          <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
            <span className="text-mint">active</span> boots warm and immediately
            advertises availability good for long-running watchers monitors and
            always-on reviewers.
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
}: {
  state: SpawnState;
  mode: SpawnMode;
  onClick: () => void;
}) {
  if (state === 'verifying') {
    return (
      <button
        disabled
        className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-amber/10 text-amber border border-amber/30 transition flex items-center gap-2 cursor-wait"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
        verifying account
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
        className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-rust/15 hover:bg-rust/25 text-rust border border-rust/30 transition flex items-center gap-2"
      >
        retry verify
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="h-8 px-4 rounded font-mono text-micro uppercase tracking-wider bg-molten/15 hover:bg-molten/25 text-molten border border-molten/30 transition"
    >
      spawn {mode === 'active' ? 'active' : 'agent'}
    </button>
  );
}
