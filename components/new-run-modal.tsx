'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';
import { IconBranch, IconMilestone, IconSettings } from './icons';
import {
  zenModels,
  familyMeta,
  fmtZenPrice,
  type ZenModel,
  type ZenFamily,
} from '@/lib/zen-catalog';

type BranchStrategy = 'push-same-branch' | 'push-new-branch' | 'local-only';
type StartMode = 'dry-run' | 'live' | 'spectator';

function generateRunId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `swarm-${id}`;
}

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

function extractRepoName(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  if (!trimmed) return '';
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function NewRunModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [sourceValue, setSourceValue] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [teamCounts, setTeamCounts] = useState<Record<string, number>>({});
  const [directive, setDirective] = useState('');
  const [unbounded, setUnbounded] = useState(true);
  const [costCap, setCostCap] = useState(5);
  const [minutesCap, setMinutesCap] = useState(15);
  const [branchStrategy, setBranchStrategy] = useState<BranchStrategy>('push-new-branch');
  const [branchName, setBranchName] = useState<string>(generateRunId);
  const [startMode, setStartMode] = useState<StartMode>('dry-run');
  const [launching, setLaunching] = useState(false);

  const totalAgents = useMemo(
    () => Object.values(teamCounts).reduce((a, n) => a + n, 0),
    [teamCounts]
  );
  const hasDirective = directive.trim().length > 0;

  const cloneTarget = useMemo(() => {
    const ws = workspacePath.trim().replace(/\/+$/, '');
    if (!ws) return '';
    const repoName = extractRepoName(sourceValue);
    return `${ws}/${repoName || '<repo>'}/`;
  }, [workspacePath, sourceValue]);

  const canLaunch =
    sourceValue.trim().length > 0 &&
    workspacePath.trim().length > 0 &&
    (branchStrategy !== 'push-new-branch' || branchName.trim().length > 0);

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

  const bumpCount = (id: string, delta: number) => {
    setTeamCounts((prev) => {
      const current = prev[id] ?? 0;
      const next = Math.max(0, Math.min(12, current + delta));
      if (next === 0) {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: next };
    });
  };

  const clearTeam = () => setTeamCounts({});

  const browseForWorkspace = async () => {
    const picker = (window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;
    }).showDirectoryPicker;
    if (typeof picker === 'function') {
      try {
        const handle = await picker({ mode: 'read' });
        setWorkspacePath(handle.name);
        return;
      } catch {
        return;
      }
    }
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => {
      const file = input.files?.[0] as (File & { webkitRelativePath?: string }) | undefined;
      const top = file?.webkitRelativePath?.split('/')[0];
      if (top) setWorkspacePath(top);
    };
    input.click();
  };

  const teamRows = useMemo(
    () =>
      Object.entries(teamCounts)
        .map(([id, count]) => {
          const model = zenModels.find((m) => m.id === id);
          return model ? { model, count } : null;
        })
        .filter((r): r is { model: ZenModel; count: number } => r !== null)
        .sort((a, b) => b.count - a.count),
    [teamCounts]
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="initiate"
      eyebrowHint={<InitiateTooltip />}
      title="new run"
      width="max-w-[1280px]"
    >
      <div
        className="grid gap-4 min-h-0"
        style={{ gridTemplateColumns: '1fr 340px' }}
      >
        <div className="min-w-0 flex flex-col gap-3">
          <Section
            step="01"
            label="source"
            hint="github repo url — the substrate the swarm reads and writes. branch and base sha are recorded into L0 at start."
          >
            <input
              value={sourceValue}
              onChange={(e) => setSourceValue(e.target.value)}
              placeholder="https://github.com/org/repo (optional branch#)"
              className="w-full h-9 px-3 rounded bg-ink-900/40 border border-dashed border-ink-600/60 text-[12.5px] text-fog-200 placeholder:text-fog-700 font-mono focus:outline-none focus:bg-ink-900 focus:border-solid focus:border-molten/40 focus:text-fog-100 transition"
            />
          </Section>

          <Section
            step="02"
            label="workspace"
            hint="parent directory on disk where the swarm will clone the repo. clone lands at {workspace}/{repo-name}/. persists across runs so recall can read prior artifacts."
          >
            <div className="space-y-1.5">
              <div className="flex items-stretch gap-1.5">
                <input
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="/abs/path/to/workspace-parent"
                  className="flex-1 min-w-0 h-9 px-3 rounded bg-ink-900/40 border border-dashed border-ink-600/60 text-[12.5px] text-fog-200 placeholder:text-fog-700 font-mono focus:outline-none focus:bg-ink-900 focus:border-solid focus:border-molten/40 focus:text-fog-100 transition"
                />
                <Tooltip
                  side="top"
                  content="opens your OS folder picker. browser-sandboxed pickers only expose the folder name, not its absolute path — type the full path if you need it exact."
                >
                  <button
                    type="button"
                    onClick={browseForWorkspace}
                    className="shrink-0 h-9 px-3 rounded bg-ink-900 border border-ink-600 text-fog-300 hover:text-fog-100 hover:border-ink-500 font-mono text-[11px] uppercase tracking-widest2 transition"
                  >
                    browse…
                  </button>
                </Tooltip>
              </div>
              {cloneTarget && (
                <div className="font-mono text-[10.5px] leading-snug flex items-center gap-1.5">
                  <span className="text-fog-700 uppercase tracking-widest2 text-[9.5px]">
                    clone →
                  </span>
                  <span className="text-mint">{cloneTarget}</span>
                </div>
              )}
            </div>
          </Section>

          <Section
            step="03"
            label="team"
            optional
            hint="pick agents from the opencode zen catalog. stack multiples of the same model with the +/− stepper. leave empty and agents will spawn as work demands."
            trailing={
              <span className="font-mono text-[10.5px] text-fog-700 tabular-nums">
                {totalAgents} on deck
              </span>
            }
          >
            <div className="rounded-md hairline bg-ink-900/40 overflow-hidden">
              <div className="px-3 h-6 hairline-b bg-ink-900/70 flex items-center gap-3">
                <HeaderCell cls="flex-1 min-w-0">model</HeaderCell>
                <HeaderCell cls="w-[82px]">family</HeaderCell>
                <HeaderCell cls="w-12 text-right">in $</HeaderCell>
                <HeaderCell cls="w-12 text-right">out $</HeaderCell>
                <HeaderCell cls="w-[74px] text-right">count</HeaderCell>
              </div>
              <ul className="max-h-[280px] overflow-y-auto">
                {zenModels.map((m) => {
                  const count = teamCounts[m.id] ?? 0;
                  const active = count > 0;
                  return (
                    <li key={m.id}>
                      <div
                        className={clsx(
                          'px-3 h-5 flex items-center gap-3 hairline-b last:border-b-0 transition',
                          active ? 'bg-ink-800' : 'hover:bg-ink-800/40'
                        )}
                      >
                        <ModelNameCell label={m.label} active={active} />
                        <FamilyCell family={m.family} />
                        <PriceCell value={fmtZenPrice(m.in)} cls="w-12 text-right" />
                        <PriceCell value={fmtZenPrice(m.out)} cls="w-12 text-right" />
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
          </Section>

          <Section
            step="04"
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
            step="05"
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
            step="06"
            label="branch strategy"
            hint="where agent commits go. three postures — each a different answer to 'how visible is this work outside my machine?'"
          >
            <div className="grid grid-cols-3 gap-2">
              <StrategyCard
                active={branchStrategy === 'push-same-branch'}
                onClick={() => setBranchStrategy('push-same-branch')}
                accent="molten"
                icon={<IconMilestone size={12} />}
                title="same branch"
                body="commits + pushes to the same branch you cloned from. loudest."
              />
              <StrategyCard
                active={branchStrategy === 'push-new-branch'}
                onClick={() => setBranchStrategy('push-new-branch')}
                accent="amber"
                icon={<IconBranch size={12} />}
                title="new branch"
                body="creates a side branch and pushes there. remote-visible, source untouched."
              />
              <StrategyCard
                active={branchStrategy === 'local-only'}
                onClick={() => setBranchStrategy('local-only')}
                accent="mint"
                icon={<IconSettings size={12} />}
                title="local only"
                body="commits stay on the cloned branch locally. never pushed."
              />
            </div>

            {branchStrategy === 'push-new-branch' && (
              <div className="mt-2 rounded-md hairline bg-ink-900/40 p-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600">
                    branch name
                  </span>
                  <Tooltip
                    side="top"
                    wide
                    content="auto-fills with a run identifier. edit to use your own name. if the name already exists on remote, the swarm appends -2, -3 etc."
                  >
                    <span className="font-mono text-[9.5px] text-fog-700 cursor-help underline decoration-dotted decoration-fog-800 underline-offset-[3px]">
                      how?
                    </span>
                  </Tooltip>
                  <button
                    onClick={() => setBranchName(generateRunId())}
                    className="ml-auto h-5 px-1.5 rounded-[3px] font-mono text-[9.5px] uppercase tracking-widest2 bg-ink-900 hairline text-fog-500 hover:text-fog-200 hover:border-ink-500 transition"
                    title="regenerate auto-name"
                  >
                    ↻ re-roll
                  </button>
                </div>
                <input
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder="swarm-<runId>"
                  className="w-full h-8 px-2.5 rounded bg-ink-900/60 border border-ink-700/60 text-[12px] font-mono text-fog-200 placeholder:text-fog-700 focus:outline-none focus:bg-ink-900 focus:border-amber/40 focus:text-fog-100 transition"
                />
              </div>
            )}
          </Section>

          <Section
            step="07"
            label="start mode"
            hint="three postures — not a severity ladder. pick the stance that matches your intent this run."
          >
            <div className="flex items-center gap-1 h-8 hairline rounded p-0.5 bg-ink-900 w-fit">
              <ModeButton
                active={startMode === 'dry-run'}
                onClick={() => setStartMode('dry-run')}
                label="dry-run"
                accent="amber"
                hint={
                  <ModeHint
                    accent="amber"
                    posture="sandbox contract"
                    body="the swarm plans and reasons but nothing hits disk."
                    when="first-contact-with-a-repo posture."
                  />
                }
              />
              <ModeButton
                active={startMode === 'live'}
                onClick={() => setStartMode('live')}
                label="live"
                accent="molten"
                hint={
                  <ModeHint
                    accent="molten"
                    posture="writes land"
                    body="changes land per the branch strategy picked in step 06."
                    when={'the "I trust this, go" posture.'}
                  />
                }
              />
              <ModeButton
                active={startMode === 'spectator'}
                onClick={() => setStartMode('spectator')}
                label="spectator"
                accent="mint"
                hint={
                  <ModeHint
                    accent="mint"
                    posture="passive observation"
                    body="the run dispatches but the composer is hidden — the human can watch but not inject mid-run."
                    when="study-the-swarm posture."
                  />
                }
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
                    github
                  </span>
                </div>

                <div className="pt-1 hairline-t">
                  <LabelRow label="workspace">
                    <span
                      className={clsx(
                        'font-mono text-[10.5px] truncate max-w-[200px]',
                        cloneTarget ? 'text-mint' : 'text-fog-700 italic'
                      )}
                      title={cloneTarget || undefined}
                    >
                      {cloneTarget || 'unset'}
                    </span>
                  </LabelRow>
                  <LabelRow label="team">
                    <span className="font-mono text-[11px] text-fog-200 tabular-nums">
                      {totalAgents || '—'}
                    </span>
                    {totalAgents > 0 && (
                      <span className="font-mono text-[10px] text-fog-600">
                        agents
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
                    <span
                      className={clsx(
                        'font-mono text-[11px]',
                        branchStrategy === 'push-same-branch' && 'text-molten',
                        branchStrategy === 'push-new-branch' && 'text-amber',
                        branchStrategy === 'local-only' && 'text-mint'
                      )}
                    >
                      {branchStrategy === 'push-same-branch'
                        ? 'same branch'
                        : branchStrategy === 'push-new-branch'
                          ? `new · ${branchName || 'unnamed'}`
                          : 'local only'}
                    </span>
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

                {teamRows.length > 0 && (
                  <div className="pt-1 hairline-t">
                    <div className="font-mono text-[9.5px] uppercase tracking-widest2 text-fog-600 mb-1">
                      lineup
                    </div>
                    <ul className="space-y-0.5 max-h-[140px] overflow-y-auto">
                      {teamRows.map(({ model, count }) => (
                        <li
                          key={model.id}
                          className="flex items-center gap-2 h-4 font-mono text-[10.5px]"
                        >
                          <span className={clsx('w-1 h-1 rounded-full', familyMeta[model.family].color.replace('text-', 'bg-'))} />
                          <span className="text-fog-300 truncate flex-1 min-w-0">
                            {model.label}
                          </span>
                          <span className="text-fog-500 tabular-nums shrink-0">
                            ×{count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
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
            ? 'team / bounds / directive optional · source + workspace anchor the run'
            : sourceValue.trim() && !workspacePath.trim()
              ? 'set a workspace to enable launch'
              : branchStrategy === 'push-new-branch' &&
                  !branchName.trim() &&
                  sourceValue.trim() &&
                  workspacePath.trim()
                ? 'name the new branch (or switch to same-branch / local-only)'
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

function CountStepper({
  count,
  onMinus,
  onPlus,
}: {
  count: number;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <div className="w-[74px] flex items-center justify-end gap-0.5 shrink-0">
      {count > 0 ? (
        <button
          onClick={onMinus}
          className="w-4 h-4 rounded-[3px] bg-ink-900 hairline text-fog-400 hover:text-fog-100 hover:border-ink-500 transition font-mono text-[11px] flex items-center justify-center"
        >
          −
        </button>
      ) : (
        <span className="w-4 h-4" aria-hidden />
      )}
      <span
        className={clsx(
          'w-6 text-center font-mono text-[11px] tabular-nums',
          count > 0 ? 'text-molten' : 'text-fog-700'
        )}
      >
        {count || '·'}
      </span>
      <button
        onClick={onPlus}
        className="w-4 h-4 rounded-[3px] hairline bg-ink-900 text-fog-400 hover:text-fog-100 hover:border-ink-500 transition font-mono text-[11px] flex items-center justify-center"
      >
        +
      </button>
    </div>
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
  accent,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  accent: 'molten' | 'amber' | 'mint';
}) {
  const accentText =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  const accentBorder =
    accent === 'molten'
      ? 'border-molten/40'
      : accent === 'amber'
        ? 'border-amber/40'
        : 'border-mint/40';
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-md hairline p-2.5 text-left transition',
        active
          ? clsx('bg-ink-800', accentBorder)
          : 'bg-ink-900/40 hover:bg-ink-800/60'
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className={clsx(active ? accentText : 'text-fog-500')}>{icon}</span>
        <span
          className={clsx(
            'font-mono text-[11px] uppercase tracking-widest2',
            active ? accentText : 'text-fog-400'
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
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: 'molten' | 'amber' | 'mint';
  hint?: React.ReactNode;
}) {
  const accentCls =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  const btn = (
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
  if (!hint) return btn;
  return (
    <Tooltip side="bottom" align="start" wide content={hint}>
      {btn}
    </Tooltip>
  );
}

function ModeHint({
  accent,
  posture,
  body,
  when,
}: {
  accent: 'molten' | 'amber' | 'mint';
  posture: string;
  body: string;
  when: string;
}) {
  const accentCls =
    accent === 'molten'
      ? 'text-molten'
      : accent === 'amber'
        ? 'text-amber'
        : 'text-mint';
  return (
    <div className="space-y-1">
      <div
        className={clsx(
          'font-mono text-micro uppercase tracking-widest2',
          accentCls
        )}
      >
        {posture}
      </div>
      <div className="font-mono text-[10.5px] text-fog-400 leading-snug">
        {body}
      </div>
      <div className="font-mono text-[10px] text-fog-600 leading-snug">
        {when}
      </div>
    </div>
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

function FamilyCell({ family }: { family: ZenFamily }) {
  const meta = familyMeta[family];
  return (
    <span
      className={clsx(
        'font-mono text-[10px] uppercase tracking-wider w-[82px] truncate',
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

function InitiateTooltip() {
  return (
    <div className="space-y-2 w-[320px]">
      <div>
        <div className="font-mono text-micro uppercase tracking-widest2 text-molten">
          initiate = seed + substrate
        </div>
        <div className="font-mono text-[10.5px] text-fog-400 leading-snug mt-0.5">
          a run is anchored to a source and a workspace. everything else is optional —
          directive, team, bounds. blank fields hand control back to the swarm.
        </div>
      </div>
      <div className="hairline-t pt-1.5">
        <div className="font-mono text-micro uppercase tracking-widest2 text-fog-500 mb-1">
          what stays sacred
        </div>
        <ul className="space-y-0.5 font-mono text-[10.5px] text-fog-400 leading-snug">
          <li>· source — the github repo agents read and write</li>
          <li>· workspace — parent directory where the clone lands</li>
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
          <li>· team — agents spawn as work demands</li>
          <li>· bounds — defaults if unbounded, revises mid-run</li>
        </ul>
      </div>
    </div>
  );
}
