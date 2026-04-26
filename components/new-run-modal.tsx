'use client';

import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { SWARM_RUNS_QUERY_KEY } from '@/lib/opencode/live';
import { Modal } from './ui/modal';
import { Tooltip } from './ui/tooltip';
import { IconBranch, IconMilestone, IconSettings } from './icons';
import {
  zenModels,
  familyMeta,
  fmtZenPrice,
  type ZenModel,
} from '@/lib/zen-catalog';
import {
  patternMeta,
  patternAccentText,
  teamSizeWarningMessage,
} from '@/lib/swarm-patterns';
import type { SwarmPattern } from '@/lib/swarm-types';
import type {
  SwarmRunRequest,
  SwarmRunResponse,
} from '@/lib/swarm-run-types';
import {
  type BranchStrategy,
  type StartMode,
  type Inferred,
  generateRunId,
  extractRepoName,
  API_RECIPES,
  inferred,
} from './new-run/helpers';
import {
  Section,
  CountStepper,
  BoundRow,
  PatternCard,
  StrategyCard,
  ModeButton,
  ModeHint,
  LabelRow,
  InferBlock,
  HeaderCell,
  ModelNameCell,
  FamilyCell,
  PriceCell,
  InitiateTooltip,
} from './new-run/sub-components';

// Helper types + constants moved to ./new-run/helpers.ts
// Visual subcomponents moved to ./new-run/sub-components.tsx
// Both extracted 2026-04-26 so the modal body reads as the actual
// flow (state + validators + sections + launch handler) without
// scrolling past hundreds of lines of presentation primitives.

export function NewRunModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [sourceValue, setSourceValue] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [pattern, setPattern] = useState<SwarmPattern>('none');
  const [teamCounts, setTeamCounts] = useState<Record<string, number>>({});
  const [directive, setDirective] = useState('');
  const [unbounded, setUnbounded] = useState(true);
  const [costCap, setCostCap] = useState(5);
  const [minutesCap, setMinutesCap] = useState(15);
  const [branchStrategy, setBranchStrategy] = useState<BranchStrategy>('push-new-branch');
  const [branchName, setBranchName] = useState<string>(generateRunId);
  const [startMode, setStartMode] = useState<StartMode>('dry-run');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [copiedPattern, setCopiedPattern] = useState<SwarmPattern | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const copyRecipe = async (p: SwarmPattern, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedPattern(p);
      // Revert "copied ✓" chip after a beat.
      setTimeout(() => setCopiedPattern((cur) => (cur === p ? null : cur)), 1200);
    } catch {
      // Clipboard blocked (e.g. non-secure context) — no-op; user can still
      // drag-select. Prototype doesn't warrant a fallback prompt.
    }
  };

  const totalAgents = useMemo(
    () => Object.values(teamCounts).reduce((a, n) => a + n, 0),
    [teamCounts]
  );
  const hasDirective = directive.trim().length > 0;

  // Per-pattern recommended-max readout (#103). Reads patternMeta.recommendedMax
  // — the same value the kickoff WARN (#101) and the MAXTEAM-2026-04-26 stress
  // test ledger emit. Empty totalAgents means "auto-default at server"; we
  // still surface the recommendation so the user can tune their stack
  // intentionally.
  const recommendedMax = patternMeta[pattern].recommendedMax;
  const teamSizeWarn = totalAgents > 0
    ? teamSizeWarningMessage(pattern, totalAgents)
    : undefined;

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

  const handleLaunch = async () => {
    if (!canLaunch || launching) return;
    setLaunching(true);
    setLaunchError(null);
    const directory = workspacePath.trim();
    const prompt = directive.trim();
    // Seed the session title from the directive's first line. Without this
    // opencode falls back to "New session - <iso>", which makes the picker
    // list of sessions useless for spotting what each one is about.
    const firstLine = prompt.split(/\r?\n/)[0] ?? '';
    const title =
      firstLine.length > 80
        ? firstLine.slice(0, 77).trimEnd() + '…'
        : firstLine || undefined;
    // Honest plumbing: workspace → opencode ?directory=, directive → first
    // prompt. source, pattern (when != 'none'), team, bounds, branch
    // strategy, start mode are recorded into meta.json but don't drive
    // runtime behavior yet — the server reads them for later replay.
    const body: SwarmRunRequest = {
      pattern,
      workspace: directory,
    };
    if (sourceValue.trim()) body.source = sourceValue.trim();
    if (prompt) body.directive = prompt;
    if (title) body.title = title;
    if (totalAgents > 0) body.teamSize = totalAgents;
    // Flatten teamCounts into a per-session model list. Order matters:
    // catalog order is stable (see zen-catalog.ts), so iterating via
    // zenModels preserves a deterministic slot assignment. Each count
    // N emits N copies of the model ID. Empty totalAgents = undefined
    // teamModels = opencode picks each session's model from its
    // default agent config.
    if (totalAgents > 0) {
      const teamModels: string[] = [];
      for (const model of zenModels) {
        const count = teamCounts[model.id] ?? 0;
        for (let i = 0; i < count; i += 1) teamModels.push(model.id);
      }
      body.teamModels = teamModels;
    }
    if (!unbounded) body.bounds = { costCap, minutesCap };
    try {
      const res = await fetch('/api/swarm/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(
          (detail as { error?: string }).error ??
            `swarm run create -> HTTP ${res.status}`
        );
      }
      const payload = (await res.json()) as SwarmRunResponse;
      // #7.Q39 — invalidate the runs-list cache so the just-spawned run
      // surfaces in the picker immediately instead of waiting for the
      // next 4s poll. The picker mounts on the destination page so by
      // the time the user opens it the cache will have refetched. Fire-
      // and-forget; nav doesn't gate on the invalidate completing.
      void queryClient.invalidateQueries({ queryKey: SWARM_RUNS_QUERY_KEY });
      onClose();
      router.push(`/?swarmRun=${encodeURIComponent(payload.swarmRunID)}`);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
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
            label="pattern"
            hint="how agents coordinate run-wide — not role assignments. none = opencode native (one session, task tool for sub-agents). blackboard / map-reduce / council are orchestration shapes above opencode and unlock as their backends ship."
          >
            <div className="grid grid-cols-4 gap-2">
              {(Object.keys(patternMeta) as SwarmPattern[]).map((p) => (
                <PatternCard
                  key={p}
                  meta={patternMeta[p]}
                  active={pattern === p}
                  onClick={() => patternMeta[p].available && setPattern(p)}
                />
              ))}
            </div>
          </Section>

          <Section
            step="04"
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

          <Section
            step="05"
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
            step="06"
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
            step="07"
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
            step="08"
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
                  <LabelRow label="pattern">
                    <span
                      className={clsx(
                        'font-mono text-[11px]',
                        patternAccentText[patternMeta[pattern].accent]
                      )}
                    >
                      {patternMeta[pattern].label}
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
              wires: <span className="text-mint">workspace</span> → opencode session (
              <span className="text-fog-600">POST /session?directory=</span>),{' '}
              <span className="text-mint">directive</span> → first prompt. aspirational:{' '}
              <span className="text-amber/80">source · pattern · team · bounds · branch · start mode</span>
              {' '}— UI-only until opencode grows matching endpoints.
            </div>
          </div>
        </aside>
      </div>

      {/* Collapsible curl-recipe reference for API users. Default closed
          so it doesn't compete with the form; one-click expand shows
          every pattern's POST body with copy affordances. */}
      <div className="mt-4 rounded-md hairline bg-ink-900/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setRecipesOpen((v) => !v)}
          className="w-full h-7 px-3 flex items-center gap-2 text-left hover:bg-ink-900/60 transition"
          aria-expanded={recipesOpen}
        >
          <span
            className={clsx(
              'font-mono text-[10px] leading-none text-fog-500 transition-transform',
              recipesOpen && 'rotate-90',
            )}
            aria-hidden
          >
            ▸
          </span>
          <span className="font-mono text-micro uppercase tracking-widest2 text-fog-500">
            api recipes
          </span>
          <span className="font-mono text-[10px] text-fog-700 ml-auto">
            {recipesOpen
              ? 'click any pattern to copy its curl body'
              : `${API_RECIPES.length} patterns · click to expand`}
          </span>
        </button>
        {recipesOpen && (
          <div className="hairline-t divide-y divide-ink-800">
            {API_RECIPES.map((recipe) => {
              const meta = patternMeta[recipe.pattern];
              const isCopied = copiedPattern === recipe.pattern;
              return (
                <div key={recipe.pattern} className="px-3 py-2">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span
                      className={clsx(
                        'font-mono text-[10px] uppercase tracking-widest2 shrink-0',
                        patternAccentText[meta.accent],
                      )}
                    >
                      {recipe.pattern}
                    </span>
                    <span className="font-mono text-[10px] text-fog-600 truncate">
                      — {recipe.hint}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyRecipe(recipe.pattern, recipe.body)}
                      className={clsx(
                        'ml-auto h-5 px-1.5 rounded font-mono text-[9px] uppercase tracking-widest2 border transition shrink-0',
                        isCopied
                          ? 'bg-mint/15 text-mint border-mint/30'
                          : 'bg-ink-900 text-fog-500 border-ink-700 hover:text-fog-200 hover:border-ink-500',
                      )}
                    >
                      {isCopied ? 'copied ✓' : 'copy'}
                    </button>
                  </div>
                  <pre className="font-mono text-[10.5px] text-fog-300 leading-snug whitespace-pre-wrap break-all bg-ink-900/60 rounded px-2 py-1.5 border border-ink-800">
                    {recipe.body}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 pt-3 hairline-t flex items-center gap-2">
        <button
          onClick={onClose}
          className="h-8 px-3 rounded font-mono text-micro uppercase tracking-wider bg-ink-900 hairline text-fog-400 hover:border-ink-500 transition"
        >
          cancel
        </button>
        {launchError ? (
          <span className="font-mono text-[10.5px] text-rust truncate max-w-[420px]" title={launchError}>
            launch failed: {launchError}
          </span>
        ) : (
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
        )}
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

