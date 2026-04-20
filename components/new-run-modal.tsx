'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';
import { IconBranch, IconMilestone, IconSettings } from './icons';
import { agents as rosterAgents } from '@/lib/swarm-data';

type Source = 'github' | 'local';
type BranchStrategy = 'worktree' | 'branch' | 'pr-only';
type StartMode = 'dry-run' | 'live' | 'spectator';

interface Inferred {
  focus: string[];
  hotspots: string[];
  openWork: string[];
}

// Mocked "what the swarm would infer from the substrate" when directive is blank.
// In real wiring: reads README + recent commits + open issues + PR titles.
const inferred: Inferred = {
  focus: ['reduce build time', 'stabilize flaky e2e', 'document public api'],
  hotspots: ['apps/web/src/lib/queue/**', 'packages/core/src/serializer.ts'],
  openWork: ['#412 race in ws reconnect', '#417 perf regression in /search'],
};

export function NewRunModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [source, setSource] = useState<Source>('github');
  const [sourceValue, setSourceValue] = useState('');
  const [teamPicks, setTeamPicks] = useState<Set<string>>(new Set());
  const [spawnFresh, setSpawnFresh] = useState(0);
  const [directive, setDirective] = useState('');
  const [unbounded, setUnbounded] = useState(true);
  const [costCap, setCostCap] = useState(5);
  const [minutesCap, setMinutesCap] = useState(15);
  const [branchStrategy, setBranchStrategy] = useState<BranchStrategy>('worktree');
  const [startMode, setStartMode] = useState<StartMode>('dry-run');
  const [launching, setLaunching] = useState(false);

  const totalAgents = teamPicks.size + spawnFresh;
  const hasDirective = directive.trim().length > 0;

  const sourcePlaceholder =
    source === 'github'
      ? 'https://github.com/org/repo (optional branch#)'
      : '/abs/path/to/project';

  const canLaunch = sourceValue.trim().length > 0;

  const launchLabel = useMemo(() => {
    if (launching) return 'launching run';
    if (startMode === 'dry-run') return 'launch dry-run';
    if (startMode === 'spectator') return 'launch spectator';
    return 'launch run';
  }, [launching, startMode]);

  const handleLaunch = () => {
    if (!canLaunch || launching) return;
    setLaunching(true);
    setTimeout(() => {
      setLaunching(false);
      onClose();
    }, 900);
  };

  const toggleTeamPick = (id: string) => {
    setTeamPicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="initiate"
      eyebrowHint={<InitiateTooltip />}
      title="new run"
      width="max-w-[1200px]"
    >
      <div
        className="grid gap-4 min-h-0"
        style={{ gridTemplateColumns: '1fr 340px' }}
      >
        <div className="min-w-0 flex flex-col gap-3">
          <Section
            step="01"
            label="source"
            hint="github repo or a local folder path — the substrate the swarm reads and writes. branch and base sha are recorded into L0 at start."
          >
            <div className="flex items-center gap-1 mb-1.5">
              <SegButton active={source === 'github'} onClick={() => setSource('github')}>
                github
              </SegButton>
              <SegButton active={source === 'local'} onClick={() => setSource('local')}>
                local folder
              </SegButton>
            </div>
            <input
              value={sourceValue}
              onChange={(e) => setSourceValue(e.target.value)}
              placeholder={sourcePlaceholder}
              className="w-full h-9 px-3 rounded bg-ink-900/40 border border-dashed border-ink-600/60 text-[12.5px] text-fog-200 placeholder:text-fog-700 font-mono focus:outline-none focus:bg-ink-900 focus:border-solid focus:border-molten/40 focus:text-fog-100 transition"
            />
          </Section>

          <Section
            step="02"
            label="team"
            optional
            hint="pick existing agents from the roster or spawn fresh generalists. leave both at zero and the orchestrator will spawn as it goes."
            trailing={
              <span className="font-mono text-[10.5px] text-fog-700 tabular-nums">
                {totalAgents} on deck
              </span>
            }
          >
            <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
              <div className="px-3 h-6 hairline-b bg-ink-900/70 flex items-center gap-2">
                <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600">
                  existing roster
                </span>
                <span className="ml-auto font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700">
                  click to include
                </span>
              </div>
              <ul>
                {rosterAgents.map((a) => {
                  const active = teamPicks.has(a.id);
                  return (
                    <li key={a.id}>
                      <button
                        onClick={() => toggleTeamPick(a.id)}
                        className={clsx(
                          'w-full px-3 h-6 flex items-center gap-2.5 hairline-b last:border-b-0 transition text-left',
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
                        <span className="font-mono text-[11.5px] text-fog-200 truncate w-[120px]">
                          {a.name}
                        </span>
                        <span className="font-mono text-[10px] text-fog-600 truncate">
                          {a.model.label}
                        </span>
                        <span className="ml-auto font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700">
                          {a.model.provider}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
                spawn fresh
              </span>
              <div className="flex items-center gap-0.5">
                <StepButton onClick={() => setSpawnFresh((n) => Math.max(0, n - 1))}>
                  −
                </StepButton>
                <span className="w-8 text-center font-mono text-[12px] text-fog-200 tabular-nums">
                  {spawnFresh}
                </span>
                <StepButton onClick={() => setSpawnFresh((n) => Math.min(12, n + 1))}>
                  +
                </StepButton>
              </div>
              <span className="font-mono text-[10.5px] text-fog-700 leading-snug">
                generalists · shape derives from behavior (§4.2)
              </span>
            </div>
          </Section>

          <Section
            step="03"
            label="directive"
            optional
            hint="big-picture goal or desired direction. leave blank and the swarm will read the substrate — readme, recent commits, open issues — and infer focus on its own."
            trailing={
              !hasDirective && (
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-amber/70">
                  will infer from substrate
                </span>
              )
            }
          >
            <textarea
              value={directive}
              onChange={(e) => setDirective(e.target.value)}
              placeholder="what should this swarm push toward? (optional — leave blank to let the swarm set its own goals from what's in the repo)"
              rows={4}
              className="w-full px-3 py-2 rounded bg-ink-900/40 border border-dashed border-ink-600/60 text-[12.5px] text-fog-400 placeholder:text-fog-700 focus:outline-none focus:bg-ink-900 focus:border-solid focus:border-molten/40 focus:text-fog-200 transition resize-none leading-relaxed font-mono"
            />
          </Section>

          <Section
            step="04"
            label="bounds"
            optional
            hint="soft caps on spend and wallclock. toggle unbounded if you want to see what the swarm does with no ceiling — useful for calibration runs, risky for everything else."
            trailing={
              <label className="flex items-center gap-1.5 cursor-pointer">
                <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
                  unbounded
                </span>
                <span
                  className={clsx(
                    'relative w-7 h-3.5 rounded-full transition',
                    unbounded ? 'bg-molten/70' : 'bg-ink-700'
                  )}
                >
                  <span
                    className={clsx(
                      'absolute top-0.5 w-2.5 h-2.5 rounded-full bg-fog-100 transition',
                      unbounded ? 'left-[14px]' : 'left-0.5'
                    )}
                  />
                </span>
                <input
                  type="checkbox"
                  checked={unbounded}
                  onChange={(e) => setUnbounded(e.target.checked)}
                  className="sr-only"
                />
              </label>
            }
          >
            <div
              className={clsx(
                'rounded-md hairline bg-ink-900/40 p-3 space-y-2 transition',
                unbounded && 'opacity-40 pointer-events-none'
              )}
            >
              <BoundRow
                label="spend"
                value={costCap}
                min={0.5}
                max={50}
                step={0.25}
                format={(v) => `$${v.toFixed(2)}`}
                onChange={setCostCap}
              />
              <BoundRow
                label="wallclock"
                value={minutesCap}
                min={1}
                max={180}
                step={1}
                format={(v) => `${v}m`}
                onChange={setMinutesCap}
              />
            </div>
          </Section>

          <Section
            step="05"
            label="branch strategy"
            hint="how agent-written changes land. worktree keeps the main tree untouched; branch lets agents commit to a side branch; pr-only emits a patch file for human review only."
          >
            <div className="grid grid-cols-3 gap-2">
              <StrategyCard
                active={branchStrategy === 'worktree'}
                onClick={() => setBranchStrategy('worktree')}
                icon={<IconBranch size={12} />}
                title="worktree"
                body="isolated git worktree; main tree untouched"
              />
              <StrategyCard
                active={branchStrategy === 'branch'}
                onClick={() => setBranchStrategy('branch')}
                icon={<IconMilestone size={12} />}
                title="branch"
                body="side branch on same clone; pushes allowed"
              />
              <StrategyCard
                active={branchStrategy === 'pr-only'}
                onClick={() => setBranchStrategy('pr-only')}
                icon={<IconSettings size={12} />}
                title="pr-only"
                body="patch file emitted for human review"
              />
            </div>
          </Section>

          <Section
            step="06"
            label="start mode"
            hint="how the run begins. dry-run plans but does not write. live dispatches immediately. spectator runs the agents but hides the composer from the human."
          >
            <div className="flex items-center gap-1 h-8 hairline rounded p-0.5 bg-ink-900 w-fit">
              <ModeButton
                active={startMode === 'dry-run'}
                onClick={() => setStartMode('dry-run')}
                label="dry-run"
                accent="amber"
              />
              <ModeButton
                active={startMode === 'live'}
                onClick={() => setStartMode('live')}
                label="live"
                accent="molten"
              />
              <ModeButton
                active={startMode === 'spectator'}
                onClick={() => setStartMode('spectator')}
                label="spectator"
                accent="mint"
              />
            </div>
          </Section>
        </div>

        <aside className="min-w-0 flex flex-col gap-3">
          <div>
            <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600 mb-2">
              preview
            </div>
            <div className="relative rounded-md hairline bg-ink-900/60 overflow-hidden border border-molten/30">
              <div className="h-[3px] w-full bg-molten/70" />
              <div className="p-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-molten" />
                  <span
                    className={clsx(
                      'text-[13px] truncate flex-1 min-w-0 font-mono',
                      sourceValue.trim() ? 'text-fog-100' : 'text-fog-700 italic'
                    )}
                  >
                    {sourceValue.trim() || 'source not set'}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-widest2 text-fog-600">
                    {source}
                  </span>
                </div>

                <div className="pt-1 hairline-t">
                  <LabelRow label="team">
                    <span className="font-mono text-[11px] text-fog-200 tabular-nums">
                      {totalAgents || '—'}
                    </span>
                    {teamPicks.size > 0 && (
                      <span className="font-mono text-[10px] text-fog-600">
                        + {spawnFresh} fresh
                      </span>
                    )}
                  </LabelRow>
                  <LabelRow label="bounds">
                    <span
                      className={clsx(
                        'font-mono text-[11px] tabular-nums',
                        unbounded ? 'text-amber/80' : 'text-fog-200'
                      )}
                    >
                      {unbounded ? 'unbounded' : `$${costCap.toFixed(2)} · ${minutesCap}m`}
                    </span>
                  </LabelRow>
                  <LabelRow label="branches">
                    <span className="font-mono text-[11px] text-fog-200">{branchStrategy}</span>
                  </LabelRow>
                  <LabelRow label="start">
                    <span
                      className={clsx(
                        'font-mono text-[11px]',
                        startMode === 'live' && 'text-molten',
                        startMode === 'dry-run' && 'text-amber',
                        startMode === 'spectator' && 'text-mint'
                      )}
                    >
                      {startMode}
                    </span>
                  </LabelRow>
                </div>
              </div>
            </div>
          </div>

          {!hasDirective && sourceValue.trim() && (
            <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
              <div className="px-3 h-6 hairline-b bg-ink-900/70 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-amber" />
                <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-amber/70">
                  substrate inference
                </span>
                <Tooltip
                  side="top"
                  wide
                  content={
                    <div className="font-mono text-[10.5px] text-fog-500 leading-snug">
                      without a directive, the swarm reads README, recent commits, open issues
                      and PR titles, and proposes its own focus. you can still intervene via
                      composer once the run is live.
                    </div>
                  }
                >
                  <span className="ml-auto font-mono text-[9.5px] uppercase tracking-widest2 text-fog-700 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px]">
                    how?
                  </span>
                </Tooltip>
              </div>
              <div className="p-3 space-y-2">
                <InferBlock title="likely focus" items={inferred.focus} />
                <InferBlock title="hotspots" items={inferred.hotspots} mono />
                <InferBlock title="open work" items={inferred.openWork} mono />
              </div>
            </div>
          )}

          <div className="rounded-md hairline bg-ink-900/40 p-3 space-y-1.5">
            <div className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
              what this writes
            </div>
            <div className="text-[11px] text-fog-400 leading-snug">
              one <span className="text-fog-200">swarm-run</span> record in L0, one child
              session per agent in opencode. L2 rollup is written at close (§7.4). the swarm
              can revise its own goals mid-run — the directive is a seed, not a contract.
            </div>
          </div>
        </aside>
      </div>

      <div className="mt-4 pt-3 hairline-t flex items-center gap-2">
        <button
          onClick={onClose}
          className="h-8 px-3 rounded font-mono text-micro uppercase tracking-wider bg-ink-900 hairline text-fog-400 hover:border-ink-500 transition"
        >
          cancel
        </button>
        <span className="font-mono text-[10.5px] text-fog-700">
          {canLaunch
            ? 'bounds and directive are optional · source anchors the run'
            : 'add a source to enable launch'}
        </span>
        <button
          onClick={handleLaunch}
          disabled={!canLaunch || launching}
          className={clsx(
            'ml-auto h-8 px-4 rounded font-mono text-micro uppercase tracking-wider border transition flex items-center gap-2',
            canLaunch && !launching
              ? 'bg-molten/15 hover:bg-molten/25 text-molten border-molten/30'
              : 'bg-ink-900 text-fog-700 border-ink-700 cursor-not-allowed'
          )}
        >
          {launching && <span className="w-1.5 h-1.5 rounded-full bg-molten animate-pulse" />}
          {launchLabel}
        </button>
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

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'h-6 px-2.5 rounded font-mono text-micro uppercase tracking-widest2 transition',
        active
          ? 'bg-ink-800 text-fog-100 hairline'
          : 'text-fog-600 hover:text-fog-300'
      )}
    >
      {children}
    </button>
  );
}

function StepButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="w-5 h-5 rounded hairline bg-ink-900 text-fog-400 hover:text-fog-100 hover:border-ink-500 transition font-mono text-[12px] flex items-center justify-center"
    >
      {children}
    </button>
  );
}

function BoundRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="grid grid-cols-[70px_1fr_80px] items-center gap-2">
      <span className="font-mono text-[10.5px] uppercase tracking-widest2 text-fog-600">
        {label}
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-molten cursor-pointer"
        aria-label={`${label} cap`}
      />
      <span className="font-mono text-[11px] tabular-nums text-fog-300 text-right">
        {format(value)}
      </span>
    </div>
  );
}

function StrategyCard({
  active,
  onClick,
  icon,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-md hairline p-2.5 text-left transition',
        active
          ? 'bg-ink-800 border-molten/40'
          : 'bg-ink-900/40 hover:bg-ink-800/60'
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className={clsx(active ? 'text-molten' : 'text-fog-500')}>{icon}</span>
        <span
          className={clsx(
            'font-mono text-[11px] uppercase tracking-widest2',
            active ? 'text-fog-100' : 'text-fog-400'
          )}
        >
          {title}
        </span>
      </div>
      <div className="font-mono text-[10px] text-fog-600 leading-snug">{body}</div>
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: 'molten' | 'amber' | 'mint';
}) {
  const accentCls =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  return (
    <button
      onClick={onClick}
      className={clsx(
        'h-7 px-3 rounded font-mono text-micro uppercase tracking-wider transition',
        active
          ? clsx('bg-ink-800 hairline', accentCls)
          : 'text-fog-600 hover:text-fog-300'
      )}
    >
      {label}
    </button>
  );
}

function LabelRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 h-5">
      <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 w-16 shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-1.5 ml-auto">{children}</div>
    </div>
  );
}

function InferBlock({
  title,
  items,
  mono,
}: {
  title: string;
  items: string[];
  mono?: boolean;
}) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-widest2 text-fog-600 mb-0.5">
        {title}
      </div>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li
            key={it}
            className={clsx(
              'text-[10.5px] text-fog-400 leading-snug truncate',
              mono ? 'font-mono' : ''
            )}
          >
            · {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InitiateTooltip() {
  return (
    <div className="space-y-2 w-[320px]">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-molten">
          initiate = seed + substrate
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug mt-0.5">
          a run is anchored to a source (repo or folder). everything else is optional —
          directive, team size, bounds. blank fields hand control back to the swarm.
        </div>
      </div>
      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          what stays sacred
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>· source — the substrate agents read and write</li>
          <li>· start mode — dry-run / live / spectator</li>
          <li>· branch strategy — how writes land</li>
        </ul>
      </div>
      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          what the swarm can set itself
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>· goal — inferred from readme / commits / issues</li>
          <li>· team — orchestrator spawns as work demands</li>
          <li>· bounds — defaults if unbounded, revises mid-run</li>
        </ul>
      </div>
    </div>
  );
}
