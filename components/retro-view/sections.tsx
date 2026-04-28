'use client';

// Header + body sections for RetroView.
//
//   Header              run id + outcome chip + (#7.Q40) failure chip
//   RunOverview         directive + meta dl (workspace / time / cost / sessions)
//   LessonsBlock        ranked lesson list (load-bearing per DESIGN.md §7.4)
//   ArtifactGraphBlock  files final + commits / PR URLs
//   Meta                small helper for the dl rows
//
// Lifted from retro-view.tsx 2026-04-28 along with the section-local
// formatters (fmtMinutes / fmtDuration / fmtCost / fmtAbsTime) and the
// failure-stop classifier. Pure renders driven by the RunRetro /
// TickerSnapshot props from the parent.

import clsx from 'clsx';
import Link from 'next/link';
import type { RunRetro } from '@/lib/server/memory/types';
import type { TickerSnapshot } from '@/lib/blackboard/live';
import { OUTCOME_TONE, fmtTokens } from './_shared';

// Stop reasons that indicate the run hit a failure mode (vs a graceful
// cap or operator action). Mirrors the set used in deriveRunRow's Q35
// classifier — keep these in sync if either side adds a new reason.
const FAILURE_STOP_REASONS = new Set<string>([
  'opencode-frozen',
  'zen-rate-limit',
  'replan-loop-exhausted',
]);

function isFailureStop(ticker: TickerSnapshot | null | undefined): boolean {
  if (!ticker || !ticker.stopped || !ticker.stopReason) return false;
  return FAILURE_STOP_REASONS.has(ticker.stopReason);
}

function fmtMinutes(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return '—';
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

function fmtAbsTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const LESSON_TONE: Record<string, string> = {
  'tool-failure':    'text-rust border-rust/30 bg-rust/5',
  'routing-miss':    'text-amber border-amber/30 bg-amber/5',
  'good-pattern':    'text-mint border-mint/30 bg-mint/5',
  'user-correction': 'text-iris border-iris/30 bg-iris/5',
};

export function Header({
  retro,
  swarmRunID,
  ticker,
}: {
  retro: RunRetro | null;
  swarmRunID: string;
  ticker?: TickerSnapshot | null;
}) {
  const tone = retro ? OUTCOME_TONE[retro.outcome] : OUTCOME_TONE.partial;
  // #7.Q40 — failure chip surfaces when the ticker stopped with a
  // failure-mode reason. Computes minute-mark from the ticker's own
  // start/stop timestamps so it survives outcome-tone churn.
  const failure = isFailureStop(ticker);
  const failureMinutes =
    failure && ticker?.stoppedAtMs && ticker?.startedAtMs
      ? fmtMinutes(ticker.stoppedAtMs - ticker.startedAtMs)
      : null;
  return (
    <header className="h-10 hairline-b bg-ink-850/80 backdrop-blur sticky top-0 z-10 flex items-center gap-3 px-4">
      <Link
        href="/"
        className="font-mono text-micro uppercase tracking-widest2 text-fog-600 hover:text-fog-200 transition"
      >
        ← runs
      </Link>
      <span className="font-mono text-micro uppercase tracking-widest2 text-fog-700">retro</span>
      <span className="font-mono text-[10.5px] tabular-nums text-fog-400 truncate">
        {swarmRunID}
      </span>
      {failure && (
        <span
          className="ml-2 inline-flex items-center gap-1.5 h-5 px-2 rounded font-mono text-[10px] uppercase tracking-widest2 bg-rust/15 text-rust border border-rust/30 shrink-0"
          title={`run stopped with failure reason: ${ticker?.stopReason ?? '(unknown)'}`}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-rust" />
          {failureMinutes ? `stopped at ${failureMinutes}` : 'stopped'}
          <span className="text-rust/70">·</span>
          <span>{ticker?.stopReason}</span>
        </span>
      )}
      {retro && (
        <span className="flex items-center gap-1.5 ml-auto shrink-0">
          <span className={clsx('w-1.5 h-1.5 rounded-full', tone.dot)} />
          <span
            className={clsx(
              'font-mono text-micro uppercase tracking-widest2',
              tone.text
            )}
          >
            {retro.outcome}
          </span>
        </span>
      )}
    </header>
  );
}

export function RunOverview({ retro }: { retro: RunRetro }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          run overview
        </span>
      </div>
      <div className="px-3 py-3 space-y-2">
        {retro.directive && (
          <p className="font-mono text-[11.5px] text-fog-200 leading-snug whitespace-pre-wrap">
            {retro.directive}
          </p>
        )}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[10.5px]">
          <Meta label="workspace" value={retro.workspace} />
          <Meta
            label="started"
            value={fmtAbsTime(retro.timeline.start)}
          />
          <Meta
            label="ended"
            value={fmtAbsTime(retro.timeline.end)}
          />
          <Meta
            label="duration"
            value={fmtDuration(retro.timeline.durationMs)}
          />
          <Meta
            label="tokens"
            value={`${fmtTokens(retro.cost.tokensTotal)} total`}
          />
          <Meta label="cost" value={fmtCost(retro.cost.costUSD)} />
          <Meta
            label="sessions"
            value={`${retro.participants.length}`}
          />
        </dl>
      </div>
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="uppercase tracking-widest2 text-fog-700">{label}</dt>
      <dd className="text-fog-200 tabular-nums break-all">{value}</dd>
    </>
  );
}

export function LessonsBlock({ lessons }: { lessons: RunRetro['lessons'] }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          lessons
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">
          {lessons.length}
        </span>
      </div>
      <ul className="divide-y divide-ink-800">
        {lessons.map((lesson, idx) => (
          <li
            key={idx}
            className="px-3 py-2 flex items-start gap-3"
          >
            <span
              className={clsx(
                'shrink-0 px-1.5 h-4 rounded font-mono text-[9px] uppercase tracking-widest2 border flex items-center',
                LESSON_TONE[lesson.tag] ?? 'text-fog-500 border-fog-700 bg-ink-800'
              )}
            >
              {lesson.tag}
            </span>
            <span className="font-mono text-[11.5px] text-fog-200 leading-snug flex-1 min-w-0">
              {lesson.text}
            </span>
            {lesson.evidencePartIDs.length > 0 && (
              <span
                className="font-mono text-[9.5px] text-fog-600 tabular-nums shrink-0"
                title={lesson.evidencePartIDs.join('\n')}
              >
                {lesson.evidencePartIDs.length} ref
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ArtifactGraphBlock({ graph }: { graph: RunRetro['artifactGraph'] }) {
  return (
    <section className="hairline rounded bg-ink-850">
      <div className="h-6 hairline-b px-3 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-widest2 text-fog-600">
          artifacts
        </span>
        <span className="font-mono text-[10px] text-fog-700 tabular-nums">
          {graph.filesFinal.length} file{graph.filesFinal.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="max-h-[260px] overflow-y-auto">
        {graph.filesFinal.map((filePath) => (
          <li
            key={filePath}
            className="h-5 px-3 flex items-center hover:bg-ink-800/60 transition"
          >
            <span className="font-mono text-[11px] text-fog-200 truncate">
              {filePath}
            </span>
          </li>
        ))}
      </ul>
      {(graph.commits.length > 0 || graph.prURLs.length > 0) && (
        <div className="px-3 py-2 hairline-t flex items-center gap-4 font-mono text-[10.5px] text-fog-500">
          {graph.commits.length > 0 && <span>{graph.commits.length} commits</span>}
          {graph.prURLs.length > 0 && (
            <span className="flex items-center gap-2">
              {graph.prURLs.map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-iris hover:text-iris/80 truncate max-w-[300px]"
                >
                  {url}
                </a>
              ))}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
